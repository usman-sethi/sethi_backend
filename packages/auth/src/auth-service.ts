import { randomBytes } from "node:crypto";
import {
  createPasswordHasher,
  createTokenService,
  type PasswordHasher,
  type TokenService,
} from "@sethi-backend/security";
import { ZodError } from "zod";

import {
  AuthRepositoryError,
  AuthValidationError,
  DuplicateUserError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
} from "./errors.js";
import {
  loginSchema,
  registrationSchema,
} from "./schemas.js";
import type {
  AuthService,
  AuthSessionRecord,
  AuthSessionRepository,
  AuthUserRepository,
  AuthenticationResult,
  AuthSecurityEvent,
  AuthSecurityEventLogger,
  AuthUserRecord,
  PublicAuthUser,
} from "./types.js";

export interface CreateAuthServiceOptions {
  users: AuthUserRepository;
  sessions: AuthSessionRepository;
  passwordHasher?: PasswordHasher;
  tokens: TokenService;
  sessionTtlSeconds?: number;
  securityEventLogger?: AuthSecurityEventLogger;
}

export const DEFAULT_AUTH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function toPublicUser(user: AuthUserRecord): PublicAuthUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

function toValidationError(error: unknown): never {
  if (error instanceof ZodError) {
    throw new AuthValidationError(
      error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }

  throw error;
}

/**
 * Creates an authentication service and initializes its one-time dummy hash.
 */
export async function createAuthService(
  options: CreateAuthServiceOptions,
): Promise<AuthService> {
  const sessionTtlSeconds =
    options.sessionTtlSeconds ?? DEFAULT_AUTH_SESSION_TTL_SECONDS;
  if (
    !Number.isInteger(sessionTtlSeconds) ||
    sessionTtlSeconds < 60 ||
    sessionTtlSeconds > 365 * 24 * 60 * 60
  ) {
    throw new RangeError(
      "Session lifetime must be between 60 seconds and 365 days.",
    );
  }

  const passwordHasher = options.passwordHasher ?? createPasswordHasher();
  const dummyPasswordHash = await passwordHasher.hash(
    randomBytes(32).toString("base64url"),
  );
  const reportSecurityEvent = (
    event: AuthSecurityEvent,
  ): void => options.securityEventLogger?.(event);

  async function createAuthenticationResult(
    user: AuthUserRecord,
  ): Promise<AuthenticationResult> {
    const now = new Date();
    const refreshToken = options.tokens.createRefreshToken();
    let session: AuthSessionRecord;
    try {
      session = await options.sessions.create({
        userId: user.id,
        refreshTokenHash: options.tokens.hashRefreshToken(refreshToken),
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + sessionTtlSeconds * 1000),
      });
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }

    let accessToken: string;
    try {
      accessToken = await options.tokens.createAccessToken(
        user.id,
        session.id,
      );
    } catch (error) {
      try {
        const revoked = await options.sessions.revokeById(
          session.id,
          user.id,
          new Date(),
        );
        if (!revoked) {
          throw new Error("The new authentication session was not revoked.");
        }
      } catch (revokeError) {
        throw new AuthRepositoryError(
          "Unable to finalize authentication and revoke its session.",
          { cause: new AggregateError([error, revokeError]) },
        );
      }

      throw error;
    }

    return {
      accessToken,
      refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
      user: toPublicUser(user),
    };
  }

  async function register(input: unknown): Promise<AuthenticationResult> {
    let parsed: ReturnType<typeof registrationSchema.parse>;
    try {
      parsed = registrationSchema.parse(input);
    } catch (error) {
      return toValidationError(error);
    }

    const passwordHash = await passwordHasher.hash(parsed.password);
    const now = new Date();

    let user: AuthUserRecord;
    try {
      user = await options.users.create({
        email: parsed.email,
        passwordHash,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (error instanceof DuplicateUserError) {
        throw error;
      }

      throw new AuthRepositoryError(undefined, { cause: error });
    }

    return createAuthenticationResult(user);
  }

  async function login(input: unknown): Promise<AuthenticationResult> {
    let parsed: ReturnType<typeof loginSchema.parse>;
    try {
      parsed = loginSchema.parse(input);
    } catch (error) {
      return toValidationError(error);
    }

    let user: AuthUserRecord | null;
    try {
      user = await options.users.findByEmail(parsed.email);
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }

    const matchesPassword = await passwordHasher.verify(
      parsed.password,
      user?.passwordHash ?? dummyPasswordHash,
    );

    if (!user || !matchesPassword) {
      throw new InvalidCredentialsError();
    }

    return createAuthenticationResult(user);
  }

  async function refresh(refreshToken: string): Promise<AuthenticationResult> {
    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
      reportSecurityEvent({
        type: "refresh.rejected",
        reason: "invalid",
      });
      throw new InvalidRefreshTokenError();
    }

    const currentRefreshTokenHash = options.tokens.hashRefreshToken(refreshToken);
    let tokenLookup;
    try {
      tokenLookup = await options.sessions.findByRefreshTokenHash(
        currentRefreshTokenHash,
      );
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }

    if (!tokenLookup) {
      reportSecurityEvent({
        type: "refresh.rejected",
        reason: "invalid",
      });
      throw new InvalidRefreshTokenError();
    }

    const { session } = tokenLookup;
    const now = new Date();
    if (session.revokedAt !== null) {
      reportSecurityEvent({
        type: "refresh.rejected",
        reason: "revoked",
        userId: session.userId,
        sessionId: session.id,
      });
      throw new InvalidRefreshTokenError();
    }

    if (session.expiresAt.getTime() <= now.getTime()) {
      reportSecurityEvent({
        type: "refresh.rejected",
        reason: "expired",
        userId: session.userId,
        sessionId: session.id,
      });
      throw new InvalidRefreshTokenError();
    }

    if (tokenLookup.status === "consumed") {
      try {
        await options.sessions.revokeById(
          session.id,
          session.userId,
          now,
        );
      } catch (error) {
        throw new AuthRepositoryError(undefined, { cause: error });
      }

      reportSecurityEvent({
        type: "refresh.replay_detected",
        userId: session.userId,
        sessionId: session.id,
      });
      throw new InvalidRefreshTokenError();
    }

    let user: AuthUserRecord | null;
    try {
      user = await options.users.findById(session.userId);
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
    if (!user) {
      try {
        await options.sessions.revokeById(session.id, session.userId, now);
      } catch (error) {
        throw new AuthRepositoryError(undefined, { cause: error });
      }
      reportSecurityEvent({
        type: "refresh.rejected",
        reason: "invalid",
        userId: session.userId,
        sessionId: session.id,
      });
      throw new InvalidRefreshTokenError();
    }

    const nextRefreshToken = options.tokens.createRefreshToken();
    const accessToken = await options.tokens.createAccessToken(
      user.id,
      session.id,
    );
    let rotation;
    try {
      rotation = await options.sessions.rotateRefreshToken({
        id: session.id,
        userId: user.id,
        currentRefreshTokenHash,
        newRefreshTokenHash: options.tokens.hashRefreshToken(nextRefreshToken),
        updatedAt: now,
      });
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }

    if (rotation.status === "replayed") {
      reportSecurityEvent({
        type: "refresh.replay_detected",
        userId: rotation.session.userId,
        sessionId: rotation.session.id,
      });
      throw new InvalidRefreshTokenError();
    }

    if (rotation.status === "rotation_limit") {
      reportSecurityEvent({
        type: "session.revoked",
        sessionId: rotation.session.id,
      });
      reportSecurityEvent({
        type: "refresh.rejected",
        reason: "rotation_limit",
        userId: rotation.session.userId,
        sessionId: rotation.session.id,
      });
      throw new InvalidRefreshTokenError();
    }

    if (rotation.status === "invalid") {
      reportSecurityEvent({
        type: "refresh.rejected",
        reason: "invalid",
        userId: session.userId,
        sessionId: session.id,
      });
      throw new InvalidRefreshTokenError();
    }

    reportSecurityEvent({
      type: "refresh.succeeded",
      userId: user.id,
      sessionId: session.id,
    });

    return {
      accessToken,
      refreshToken: nextRefreshToken,
      refreshTokenExpiresAt: rotation.session.expiresAt,
      user: toPublicUser(user),
    };
  }

  async function logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) {
      return;
    }

    try {
      const tokenHash = options.tokens.hashRefreshToken(refreshToken);
      const tokenLookup = await options.sessions.findByRefreshTokenHash(tokenHash);
      const revoked = await options.sessions.revokeByRefreshTokenHash(
        tokenHash,
        new Date(),
      );
      if (revoked && tokenLookup) {
        reportSecurityEvent({
          type: "session.revoked",
          sessionId: tokenLookup.session.id,
        });
      }
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
  }

  async function logoutAll(userId: string): Promise<void> {
    try {
      await options.sessions.revokeAllForUser(userId, new Date());
      reportSecurityEvent({
        type: "sessions.revoked_all",
        userId,
      });
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
  }

  return {
    register,
    login,
    refresh,
    logout,
    logoutAll,
  };
}
