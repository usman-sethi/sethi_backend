import type {
  TokenService,
} from "@sethi-backend/security";

import {
  AuthRepositoryError,
  UnauthorizedError,
} from "./errors.js";
import type {
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
}

export function createAuthenticationGuard(
  options: CreateAuthenticationGuardOptions,
): AuthenticationGuard {
  return {
    async authenticate(
      authorizationHeader: string | undefined,
    ): Promise<PublicAuthUser> {
      const match = authorizationHeader?.match(/^Bearer ([^\s]+)$/i);
      const token = match?.[1];
      if (!token) {
        throw new UnauthorizedError();
      }

      const verifiedToken = await options.tokens.verifyAccessToken(token);
      if (!verifiedToken) {
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      if (!verifiedToken.sessionId) {
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      let session;
      try {
        session = await options.sessions.findById(verifiedToken.sessionId);
      } catch (error) {
        throw new AuthRepositoryError(undefined, { cause: error });
      }

      if (
        !session ||
        session.userId !== verifiedToken.subject ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= Date.now()
      ) {
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      let user: AuthUserRecord | null;
      try {
        user = await options.users.findById(verifiedToken.subject);
      } catch (error) {
        throw new AuthRepositoryError(undefined, { cause: error });
      }

      if (!user) {
        throw new UnauthorizedError("Access token is invalid or expired.");
      }

      return toPublicUser(user);
    },
  };
}
