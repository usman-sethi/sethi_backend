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
  AuthUserRecord,
  PublicAuthUser,
} from "./types.js";

export interface CreateAuthServiceOptions {
  users: AuthUserRepository;
  sessions: AuthSessionRepository;
  passwordHasher?: PasswordHasher;
  tokens: TokenService;
  sessionTtlSeconds?: number;
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
        await options.sessions.revokeById(session.id, user.id, new Date());
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
      throw new InvalidRefreshTokenError();
    }

    const currentRefreshTokenHash = options.tokens.hashRefreshToken(refreshToken);
    let session: AuthSessionRecord | null;
    try {
      session = await options.sessions.findByRefreshTokenHash(
        currentRefreshTokenHash,
      );
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }

    const now = new Date();
    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      throw new InvalidRefreshTokenError();
    }

    let user: AuthUserRecord | null;
    try {
      user = await options.users.findById(session.userId);
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
    if (!user) {
      throw new InvalidRefreshTokenError();
    }

    const nextRefreshToken = options.tokens.createRefreshToken();
    const accessToken = await options.tokens.createAccessToken(
      user.id,
      session.id,
    );
    let rotatedSession: AuthSessionRecord | null;
    try {
      rotatedSession = await options.sessions.rotateRefreshToken({
        id: session.id,
        userId: user.id,
        currentRefreshTokenHash,
        newRefreshTokenHash: options.tokens.hashRefreshToken(nextRefreshToken),
        updatedAt: now,
      });
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }

    if (!rotatedSession) {
      throw new InvalidRefreshTokenError();
    }

    return {
      accessToken,
      refreshToken: nextRefreshToken,
      refreshTokenExpiresAt: rotatedSession.expiresAt,
      user: toPublicUser(user),
    };
  }

  async function logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) {
      return;
    }

    try {
      await options.sessions.revokeByRefreshTokenHash(
        options.tokens.hashRefreshToken(refreshToken),
        new Date(),
      );
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
  }

  async function logoutAll(userId: string): Promise<void> {
    try {
      await options.sessions.revokeAllForUser(userId, new Date());
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
