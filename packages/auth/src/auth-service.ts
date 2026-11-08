import { createHash, randomBytes } from "node:crypto";
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
  ForbiddenError,
  InvalidCredentialsError,
  InvalidActionTokenError,
  InvalidRefreshTokenError,
  LastAdministratorError,
  UserNotFoundError,
  UnverifiedUserError,
} from "./errors.js";
import {
  emailInputSchema,
  loginSchema,
  passwordResetSchema,
  registrationSchema,
  verificationTokenSchema,
} from "./schemas.js";
import type {
  AuthActionTokenPurpose,
  AuthActionTokenRepository,
  AuthService,
  AuthSessionRecord,
  AuthSessionRepository,
  AuthUserRepository,
  AuthenticationResult,
  EmailSender,
  AuthSecurityEvent,
  AuthSecurityEventLogger,
  AuthUserRecord,
  UserRole,
  PublicAuthUser,
} from "./types.js";

export interface CreateAuthServiceOptions {
  users: AuthUserRepository;
  sessions: AuthSessionRepository;
  actionTokens: AuthActionTokenRepository;
  passwordHasher?: PasswordHasher;
  tokens: TokenService;
  emailSender?: EmailSender;
  appBaseUrl?: string;
  emailVerificationTokenTtlSeconds?: number;
  passwordResetTokenTtlSeconds?: number;
  sessionTtlSeconds?: number;
  securityEventLogger?: AuthSecurityEventLogger;
}

export const DEFAULT_AUTH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_EMAIL_VERIFICATION_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_PASSWORD_RESET_TOKEN_TTL_SECONDS = 30 * 60;

function hashActionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatExpiration(seconds: number): string {
  if (seconds >= 60 * 60) {
    const hours = Math.ceil(seconds / (60 * 60));
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

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
  const emailVerificationTtlSeconds =
    options.emailVerificationTokenTtlSeconds ??
    DEFAULT_EMAIL_VERIFICATION_TOKEN_TTL_SECONDS;
  const passwordResetTtlSeconds =
    options.passwordResetTokenTtlSeconds ??
    DEFAULT_PASSWORD_RESET_TOKEN_TTL_SECONDS;
  for (const [label, value] of [
    ["Email verification", emailVerificationTtlSeconds],
    ["Password reset", passwordResetTtlSeconds],
  ] as const) {
    if (!Number.isInteger(value) || value < 60 || value > 7 * 24 * 60 * 60) {
      throw new RangeError(`${label} token lifetime must be between 60 seconds and 7 days.`);
    }
  }
  if (options.appBaseUrl) {
    const appUrl = new URL(options.appBaseUrl);
    if (
      !["http:", "https:"].includes(appUrl.protocol) ||
      appUrl.username ||
      appUrl.password ||
      appUrl.search ||
      appUrl.hash
    ) {
      throw new TypeError("Application base URL must be an HTTP(S) URL without credentials, query, or fragment.");
    }
  }

  const passwordHasher = options.passwordHasher ?? createPasswordHasher();
  const dummyPasswordHash = await passwordHasher.hash(
    randomBytes(32).toString("base64url"),
  );
  const reportSecurityEvent = (
    event: AuthSecurityEvent,
  ): void => options.securityEventLogger?.(event);

  function queueEmail(
    userId: string,
    purpose: AuthActionTokenPurpose | "password-changed",
    email: string,
    subject: string,
    url: string | undefined,
    expirationSeconds?: number,
  ): void {
    const urlText = url ?? "";
    const content = purpose === "email-verification"
      ? {
        heading: "Verify your email address",
        action: "Verify email",
        description: `This link expires in ${formatExpiration(expirationSeconds ?? 0)}.`,
        notice: "If you did not create an account, you can ignore this message.",
      }
      : purpose === "password-reset"
      ? {
        heading: "Reset your password",
        action: "Reset password",
        description: `This link expires in ${formatExpiration(expirationSeconds ?? 0)}. Do not share it with anyone.`,
        notice: "If you did not request a password reset, you can ignore this message.",
      }
      : {
        heading: "Your password was changed",
        action: "",
        description: "Your account password was successfully changed.",
        notice: "If you did not make this change, contact support immediately.",
      };
    const safeEmail = escapeHtml(email);
    const safeUrl = escapeHtml(urlText);
    const html = `<p>Hello ${safeEmail},</p><h1>${content.heading}</h1><p>${content.description}</p>${url ? `<p><a href="${safeUrl}">${content.action}</a></p>` : ""}<p>${content.notice}</p>`;
    const text = [
      `Hello ${email},`,
      content.heading,
      content.description,
      url ? `${content.action}: ${url}` : "",
      content.notice,
    ].filter(Boolean).join("\n\n");

    void (async () => {
      try {
        if (!options.emailSender) {
          throw new Error("SMTP email delivery is not configured.");
        }
        await options.emailSender.send({ to: email, subject, text, html });
      } catch {
        reportSecurityEvent({
          type: "email.delivery_failed",
          purpose,
          userId,
        });
      }
    })();
  }

  function createActionUrl(path: string, token: string): string | undefined {
    if (!options.appBaseUrl) {
      return undefined;
    }
    const url = new URL(path, options.appBaseUrl);
    url.hash = new URLSearchParams({ token }).toString();
    return url.toString();
  }

  async function issueActionToken(
    user: AuthUserRecord,
    purpose: AuthActionTokenPurpose,
  ): Promise<{ token: string; expiresAt: Date }> {
    const now = new Date();
    const token = randomBytes(32).toString("base64url");
    const ttlSeconds = purpose === "email-verification"
      ? emailVerificationTtlSeconds
      : passwordResetTtlSeconds;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    try {
      await options.actionTokens.replaceForUser({
        userId: user.id,
        tokenHash: hashActionToken(token),
        purpose,
        expiresAt,
        consumedAt: null,
        createdAt: now,
      });
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }

    return { token, expiresAt };
  }

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

  async function register(input: unknown): Promise<void> {
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
        emailVerifiedAt: null,
        role: "user",
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (error instanceof DuplicateUserError) {
        return;
      }

      throw new AuthRepositoryError(undefined, { cause: error });
    }

    const { token } = await issueActionToken(user, "email-verification");
    queueEmail(
      user.id,
      "email-verification",
      user.email,
      "Verify your email address",
      createActionUrl("/verify-email", token),
      emailVerificationTtlSeconds,
    );
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

    if (!user || !matchesPassword || !user.emailVerified) {
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
    if (!user.emailVerified) {
      try {
        await options.sessions.revokeById(session.id, session.userId, now);
      } catch (error) {
        throw new AuthRepositoryError(undefined, { cause: error });
      }
      reportSecurityEvent({
        type: "refresh.rejected",
        reason: "revoked",
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

  async function verifyEmail(input: unknown): Promise<void> {
    let token: string;
    try {
      token = verificationTokenSchema.parse(input).token;
    } catch (error) {
      return toValidationError(error);
    }
    const tokenHash = hashActionToken(token);
    let record;
    try {
      record = await options.actionTokens.findByHash(tokenHash);
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
    if (
      !record ||
      record.purpose !== "email-verification" ||
      record.consumedAt !== null ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new InvalidActionTokenError();
    }
    try {
      if (!await options.actionTokens.verifyEmail(tokenHash, new Date())) {
        throw new InvalidActionTokenError();
      }
    } catch (error) {
      if (error instanceof InvalidActionTokenError) {
        throw error;
      }
      throw new AuthRepositoryError(undefined, { cause: error });
    }
  }

  async function resendVerification(input: unknown): Promise<void> {
    let email: string;
    try {
      email = emailInputSchema.parse(input).email;
    } catch (error) {
      return toValidationError(error);
    }
    let user: AuthUserRecord | null;
    try {
      user = await options.users.findByEmail(email);
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
    if (!user || user.emailVerified) {
      return;
    }
    const { token } = await issueActionToken(user, "email-verification");
    queueEmail(
      user.id,
      "email-verification",
      user.email,
      "Verify your email address",
      createActionUrl("/verify-email", token),
      emailVerificationTtlSeconds,
    );
  }

  async function requestPasswordReset(input: unknown): Promise<void> {
    let email: string;
    try {
      email = emailInputSchema.parse(input).email;
    } catch (error) {
      return toValidationError(error);
    }
    let user: AuthUserRecord | null;
    try {
      user = await options.users.findByEmail(email);
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
    if (!user || !user.emailVerified) {
      createHash("sha256").update(randomBytes(32)).digest();
      return;
    }

    const { token } = await issueActionToken(user, "password-reset");
    queueEmail(
      user.id,
      "password-reset",
      user.email,
      "Reset your password",
      createActionUrl("/reset-password", token),
      passwordResetTtlSeconds,
    );
  }

  async function resetPassword(input: unknown): Promise<void> {
    let parsed: ReturnType<typeof passwordResetSchema.parse>;
    try {
      parsed = passwordResetSchema.parse(input);
    } catch (error) {
      return toValidationError(error);
    }
    const tokenHash = hashActionToken(parsed.token);
    let record;
    try {
      record = await options.actionTokens.findByHash(tokenHash);
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
    if (
      !record ||
      record.purpose !== "password-reset" ||
      record.consumedAt !== null ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new InvalidActionTokenError();
    }
    let user: AuthUserRecord | null;
    try {
      user = await options.users.findById(record.userId);
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
    if (!user) {
      throw new InvalidActionTokenError();
    }
    const passwordHash = await passwordHasher.hash(parsed.newPassword);
    try {
      if (!await options.actionTokens.resetPassword({
        tokenHash,
        passwordHash,
        now: new Date(),
      })) {
        throw new InvalidActionTokenError();
      }
    } catch (error) {
      if (error instanceof InvalidActionTokenError) {
        throw error;
      }
      throw new AuthRepositoryError(undefined, { cause: error });
    }

    queueEmail(
      user.id,
      "password-changed",
      user.email,
      "Your password was changed",
      undefined,
    );
  }

  async function changeUserRole(
    targetUserId: string,
    role: UserRole,
    actorUserId: string,
  ): Promise<void> {
    if (targetUserId === actorUserId) {
      throw new ForbiddenError("You cannot change your own role.");
    }
    let result;
    try {
      result = await options.users.setRole(
        targetUserId,
        role,
        new Date(),
        actorUserId,
      );
    } catch (error) {
      throw new AuthRepositoryError(undefined, { cause: error });
    }
    if (result.status === "not_found") {
      throw new UserNotFoundError();
    }
    if (result.status === "last_admin") {
      throw new LastAdministratorError();
    }
    if (result.status === "email_unverified") {
      throw new UnverifiedUserError();
    }
    if (result.status === "actor_not_admin") {
      throw new ForbiddenError();
    }
    if (result.status === "updated") {
      reportSecurityEvent({
        type: "user.role_changed",
        actorUserId,
        targetUserId,
        previousRole: result.previousRole,
        role,
      });
    }
  }

  return {
    register,
    login,
    refresh,
    logout,
    logoutAll,
    changeUserRole,
    verifyEmail,
    resendVerification,
    requestPasswordReset,
    resetPassword,
  };
}
