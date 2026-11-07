
import { createHash, randomBytes } from "node:crypto";

import {
  SignJWT,
  jwtVerify,
} from "jose";

export interface TokenServiceOptions {
  secret: string;
  issuer: string;
  audience: string;
  accessTokenTtlSeconds?: number;
}

export interface VerifiedAccessToken {
  subject: string;
  issuedAt: number;
  expiresAt: number;
}

export interface TokenService {
  createAccessToken(userId: string): Promise<string>;
  verifyAccessToken(token: string): Promise<VerifiedAccessToken | null>;
  createRefreshToken(): string;
  hashRefreshToken(token: string): string;
}

export function createTokenService(
  options: TokenServiceOptions,
): TokenService {
  if (Buffer.byteLength(options.secret, "utf8") < 32) {
    throw new Error(
      "JWT secret must contain at least 32 bytes.",
    );
  }

  if (!options.issuer.trim() || !options.audience.trim()) {
    throw new Error("JWT issuer and audience are required.");
  }

  const ttl = options.accessTokenTtlSeconds ?? 900;

  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
    throw new Error(
      "Access-token lifetime must be between 60 and 3600 seconds.",
    );
  }

  const secret = new TextEncoder().encode(options.secret);

  return {
    async createAccessToken(userId: string): Promise<string> {
      if (!userId.trim()) {
        throw new Error("User ID is required.");
      }

      const now = Math.floor(Date.now() / 1000);

      return new SignJWT({
        tokenUse: "access",
      })
        .setProtectedHeader({
          alg: "HS256",
          typ: "JWT",
        })
        .setSubject(userId)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .sign(secret);
    },

    async verifyAccessToken(
      token: string,
    ): Promise<VerifiedAccessToken | null> {
      try {
        const { payload } = await jwtVerify(token, secret, {
          algorithms: ["HS256"],
          issuer: options.issuer,
          audience: options.audience,
          requiredClaims: ["sub", "iat", "exp"],
        });

        if (
          payload.tokenUse !== "access" ||
          typeof payload.sub !== "string" ||
          typeof payload.iat !== "number" ||
          typeof payload.exp !== "number"
        ) {
          return null;
        }

        return {
          subject: payload.sub,
          issuedAt: payload.iat,
          expiresAt: payload.exp,
        };
      } catch {
        // Invalid signatures, expired tokens and wrong claims
        // all produce an unsuccessful authentication result.
        return null;
      }
    },

    createRefreshToken(): string {
      return randomBytes(32).toString("base64url");
    },

    hashRefreshToken(token: string): string {
      if (!token) {
        throw new Error("Refresh token cannot be empty.");
      }

      return createHash("sha256")
        .update(token, "utf8")
        .digest("hex");
    },
  };
}
