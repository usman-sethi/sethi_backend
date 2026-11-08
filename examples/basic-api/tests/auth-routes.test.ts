import Fastify from "fastify";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createAuthService,
  createAuthenticationGuard,
  DuplicateUserError,
  type AuthSessionRepository,
  type AuthSessionRecord,
  type AuthUserRecord,
  type AuthUserRepository,
  type CreateAuthUserInput,
} from "@sethi-backend/auth";
import {
  createCsrfProtectionHook,
  generateCsrfToken,
  registerHttpSecurity,
} from "@sethi-backend/adapter-fastify";
import { registerAuthRoutes } from "../src/auth-routes.js";

function createAuthHarness() {
  const records = new Map<string, AuthUserRecord>();
  const byEmail = new Map<string, AuthUserRecord>();
  const sessions = new Map<string, AuthSessionRecord>();
  let id = 0;
  let refreshId = 0;
  const users: AuthUserRepository = {
    ensureIndexes: async () => undefined,
    findByEmail: async (email) => byEmail.get(email) ?? null,
    findById: async (userId) => records.get(userId) ?? null,
    create: async (input: CreateAuthUserInput) => {
      if (byEmail.has(input.email)) {
        throw new DuplicateUserError();
      }

      const user: AuthUserRecord = {
        id: `user-${++id}`,
        ...input,
      };
      byEmail.set(user.email, user);
      records.set(user.id, user);
      return user;
    },
  };
  const sessionRepository: AuthSessionRepository = {
    ensureIndexes: async () => undefined,
    create: async (input) => {
      const session: AuthSessionRecord = {
        id: `session-${sessions.size + 1}`,
        ...input,
        revokedAt: null,
      };
      sessions.set(session.id, session);
      return session;
    },
    findById: async (sessionId) => sessions.get(sessionId) ?? null,
    findByRefreshTokenHash: async (hash) =>
      [...sessions.values()].find((session) =>
        session.refreshTokenHash === hash
      ) ?? null,
    rotateRefreshToken: async (input) => {
      const session = sessions.get(input.id);
      if (
        !session ||
        session.userId !== input.userId ||
        session.refreshTokenHash !== input.currentRefreshTokenHash ||
        session.revokedAt !== null ||
        session.expiresAt <= input.updatedAt
      ) {
        return null;
      }
      session.refreshTokenHash = input.newRefreshTokenHash;
      session.updatedAt = input.updatedAt;
      return session;
    },
    revokeById: async (sessionId, userId, revokedAt) => {
      const session = sessions.get(sessionId);
      if (!session || session.userId !== userId || session.revokedAt) {
        return false;
      }
      session.revokedAt = revokedAt;
      return true;
    },
    revokeByRefreshTokenHash: async (hash, revokedAt) => {
      const session = [...sessions.values()].find((candidate) =>
        candidate.refreshTokenHash === hash
      );
      if (!session || session.revokedAt) {
        return false;
      }
      session.revokedAt = revokedAt;
      return true;
    },
    revokeAllForUser: async (userId, revokedAt) => {
      for (const session of sessions.values()) {
        if (session.userId === userId && !session.revokedAt) {
          session.revokedAt = revokedAt;
        }
      }
    },
  };
  const passwordHasher = {
    hash: async (password: string) => `test-hash:${password}`,
    verify: async (password: string, hash: string) =>
      hash === `test-hash:${password}`,
  };
  const tokens = {
    createAccessToken: async (userId: string, sessionId?: string) =>
      `valid:${userId}:${sessionId ?? ""}`,
    verifyAccessToken: async (token: string) => {
      const match = /^valid:([^:]+):([^:]*)$/.exec(token);
      return match
        ? {
          subject: match[1]!,
          sessionId: match[2],
          issuedAt: 1,
          expiresAt: 2,
        }
        : null;
    },
    createRefreshToken: () => `refresh-${++refreshId}`,
    hashRefreshToken: (token: string) => `hash:${token}`,
  };

  return {
    users,
    sessions: sessionRepository,
    sessionRecords: sessions,
    passwordHasher,
    tokens,
  };
}

async function csrfHeaders(server: ReturnType<typeof Fastify>) {
  const csrf = await server.inject({
    method: "GET",
    url: "/csrf-token",
  });
  const setCookie = csrf.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
    ?.split(";")[0];
  return {
    cookie,
    "x-csrf-token": csrf.json<{ token: string }>().token,
  };
}

async function createServer(
  harness: ReturnType<typeof createAuthHarness>,
) {
  const service = await createAuthService({
    ...harness,
    sessionTtlSeconds: 30 * 24 * 60 * 60,
  });
  const guard = createAuthenticationGuard(harness);
  const server = Fastify();
  registerHttpSecurity(server, {
    allowedOrigins: ["http://localhost:5173"],
    rateLimit: { enabled: false },
  });
  registerAuthRoutes(server, {
    service,
    guard,
    environment: "test",
    csrfProtection: createCsrfProtectionHook(server),
  });
  server.get("/csrf-token", async (_request, reply) => {
    return { token: generateCsrfToken(reply) };
  });
  return server;
}

describe("Basic API auth routes", () => {
  it("supports registration, login and protected profile without leaking credentials", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      const registration = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: " User@Example.com ",
          password: "a secure passphrase 123",
        },
      });

      expect(registration.statusCode, registration.body).toBe(201);
      expect(registration.json()).toMatchObject({
        accessToken: "valid:user-1:session-1",
        user: {
          id: "user-1",
          email: "user@example.com",
          emailVerified: false,
        },
      });
      expect(registration.body).not.toContain("passwordHash");
      expect(registration.body).not.toContain("refreshToken");
      const refreshCookie = registration.headers["set-cookie"];
      expect(refreshCookie).toContain("HttpOnly");
      expect(refreshCookie).toContain("refresh_token=refresh-1");

      const login = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: await csrfHeaders(server),
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      expect(login.statusCode).toBe(200);
      expect(login.body).not.toContain("passwordHash");
      expect(login.body).not.toContain("refreshToken");

      const profile = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: {
          authorization: "Bearer valid:user-1:session-1",
        },
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.json()).toMatchObject({
        user: {
          id: "user-1",
          email: "user@example.com",
        },
      });
      expect(profile.body).not.toContain("passwordHash");
    } finally {
      await server.close();
    }
  });

  it("rotates the HttpOnly refresh cookie and revokes sessions on logout", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      const registered = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      const registrationCookie = registered.headers["set-cookie"];
      const cookieHeader = (Array.isArray(registrationCookie)
        ? registrationCookie[0]
        : registrationCookie)?.split(";")[0];

      const refreshCsrf = await csrfHeaders(server);
      const refresh = await server.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: {
          ...refreshCsrf,
          cookie: `${refreshCsrf.cookie}; ${cookieHeader}`,
        },
      });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.body).not.toContain("refreshToken");
      expect(refresh.headers["set-cookie"]).toContain("refresh-2");

      const rotatedCookie = refresh.headers["set-cookie"];
      const rotatedCookieHeader = (Array.isArray(rotatedCookie)
        ? rotatedCookie[0]
        : rotatedCookie)?.split(";")[0];
      const logoutCsrf = await csrfHeaders(server);
      const logout = await server.inject({
        method: "POST",
        url: "/auth/logout",
        headers: {
          ...logoutCsrf,
          cookie: `${logoutCsrf.cookie}; ${rotatedCookieHeader}`,
        },
      });
      expect(logout.statusCode).toBe(204);
      expect([...harness.sessionRecords.values()][0]?.revokedAt)
        .toBeInstanceOf(Date);
    } finally {
      await server.close();
    }
  });

  it("revokes all device sessions on logout-all", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      const login = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: await csrfHeaders(server),
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      const accessToken = login.json<{ accessToken: string }>().accessToken;
      expect(harness.sessionRecords.size).toBe(2);

      const logoutAll = await server.inject({
        method: "POST",
        url: "/auth/logout-all",
        headers: {
          ...(await csrfHeaders(server)),
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(logoutAll.statusCode).toBe(204);
      expect(
        [...harness.sessionRecords.values()].every((session) =>
          session.revokedAt instanceof Date
        ),
      ).toBe(true);

      const staleAccess = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: {
          authorization: "Bearer valid:user-1:session-1",
        },
      });
      expect(staleAccess.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("returns expected public status codes for invalid requests and credentials", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      const invalid = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "not-an-email",
          password: "short",
          role: "admin",
        },
      });
      expect(invalid.statusCode).toBe(400);

      const missingCredentials = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: await csrfHeaders(server),
        payload: {
          email: "missing@example.com",
          password: "a secure passphrase 123",
        },
      });
      expect(missingCredentials.statusCode).toBe(401);
      expect(missingCredentials.json()).toMatchObject({
        error: { code: "AUTH_INVALID_CREDENTIALS" },
      });

      const missingAuth = await server.inject({
        method: "GET",
        url: "/auth/me",
      });
      expect(missingAuth.statusCode).toBe(401);

      const missingCsrf = await server.inject({
        method: "POST",
        url: "/auth/logout",
      });
      expect(missingCsrf.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});
