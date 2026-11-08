import type {
  TokenService,
} from "@sethi-backend/security";

import {
  AuthRepositoryError,
  UnauthorizedError,
} from "./errors.js";
import type {
  AuthSecurityEvent,
  AuthSecurityEventLogger,
  AuthSessionRepository,
  AuthenticationGuard,
  AuthUserRepository,
  AuthUserRecord,
  PublicAuthUser,
} from "./types.js";

function toPublicUser(user: AuthUserRecord): PublicAuthUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

export interface CreateAuthenticationGuardOptions {
  users: AuthUserRepository;
  sessions: AuthSessionRepository;
  tokens: TokenService;
  securityEventLogger?: AuthSecurityEventLogger;
}

export function createAuthenticationGuard(
  options: CreateAuthenticationGuardOptions,
): AuthenticationGuard {
  const reportSecurityEvent = (
    event: AuthSecurityEvent,
  ): void => options.securityEventLogger?.(event);

  return {
    async authenticate(
      authorizationHeader: string | undefined,
    ): Promise<PublicAuthUser> {
      const match = authorizationHeader?.match(/^Bearer ([^\s]+)$/i);
      const token = match?.[1];
      if (!token) {
        reportSecurityEvent({
          type: "access.rejected",
          reason: "invalid",
        });
        throw new UnauthorizedError();
      }

      const verifiedToken = await options.tokens.verifyAccessToken(token);
      if (!verifiedToken) {
        reportSecurityEvent({
          type: "access.rejected",
          reason: "invalid",
        });
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      if (!verifiedToken.sessionId) {
        reportSecurityEvent({
          type: "access.rejected",
          reason: "session_missing",
          userId: verifiedToken.subject,
        });
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      let session;
      try {
        session = await options.sessions.findById(verifiedToken.sessionId);
      } catch (error) {
        throw new AuthRepositoryError(undefined, { cause: error });
      }

      if (
        !session
      ) {
        reportSecurityEvent({
          type: "access.rejected",
          reason: "session_missing",
          userId: verifiedToken.subject,
          sessionId: verifiedToken.sessionId,
        });
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      if (session.userId !== verifiedToken.subject) {
        reportSecurityEvent({
          type: "access.rejected",
          reason: "session_mismatch",
          userId: verifiedToken.subject,
          sessionId: session.id,
        });
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      if (session.revokedAt !== null) {
        reportSecurityEvent({
          type: "access.rejected",
          reason: "session_revoked",
          userId: verifiedToken.subject,
          sessionId: session.id,
        });
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      if (session.expiresAt.getTime() <= Date.now()) {
        reportSecurityEvent({
          type: "access.rejected",
          reason: "session_expired",
          userId: verifiedToken.subject,
          sessionId: session.id,
        });
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      let user: AuthUserRecord | null;
      try {
        user = await options.users.findById(verifiedToken.subject);
      } catch (error) {
        throw new AuthRepositoryError(undefined, { cause: error });
      }

      if (!user) {
        reportSecurityEvent({
          type: "access.rejected",
          reason: "user_missing",
          userId: verifiedToken.subject,
          sessionId: session.id,
        });
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      if (!user.emailVerified) {
        reportSecurityEvent({
          type: "access.rejected",
          reason: "email_unverified",
          userId: verifiedToken.subject,
          sessionId: session.id,
        });
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      return toPublicUser(user);
    },
  };
}
