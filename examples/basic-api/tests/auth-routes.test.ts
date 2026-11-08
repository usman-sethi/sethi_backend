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
  const consumedHashes = new Map<string, string[]>();
  const securityEvents: Array<Record<string, unknown>> = [];
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
      consumedHashes.set(session.id, []);
      return session;
    },
    findById: async (sessionId) => sessions.get(sessionId) ?? null,
    findByRefreshTokenHash: async (hash) => {
      const current = [...sessions.values()].find((session) =>
        session.refreshTokenHash === hash
      );
      if (current) {
        return { session: current, status: "current" as const };
      }

      const consumed = [...sessions.values()].find((session) =>
        consumedHashes.get(session.id)?.includes(hash)
      );
      return consumed
        ? { session: consumed, status: "consumed" as const }
        : null;
    },
    rotateRefreshToken: async (input) => {
      const session = sessions.get(input.id);
      if (!session || session.revokedAt !== null || session.expiresAt <= input.updatedAt) {
        return { status: "invalid" as const };
      }
      const consumed = consumedHashes.get(session.id) ?? [];
      if (session.refreshTokenHash !== input.currentRefreshTokenHash) {
        if (consumed.includes(input.currentRefreshTokenHash)) {
          session.revokedAt = input.updatedAt;
          session.updatedAt = input.updatedAt;
          return { status: "replayed" as const, session };
        }
        return { status: "invalid" as const };
      }
      consumed.push(input.currentRefreshTokenHash);
      consumedHashes.set(session.id, consumed);
      session.refreshTokenHash = input.newRefreshTokenHash;
      session.updatedAt = input.updatedAt;
      return { status: "rotated" as const, session };
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
        candidate.refreshTokenHash === hash ||
        consumedHashes.get(candidate.id)?.includes(hash)
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
    usersByEmail: byEmail,
    sessions: sessionRepository,
    sessionRecords: sessions,
    passwordHasher,
    tokens,
    securityEvents,
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
  rateLimitEnabled = false,
  environment: "test" | "production" = "test",
) {
  const service = await createAuthService({
    ...harness,
    sessionTtlSeconds: 30 * 24 * 60 * 60,
    securityEventLogger: (event) => {
      harness.securityEvents.push(event);
    },
  });
  const guard = createAuthenticationGuard(harness);
  const server = Fastify();
  registerHttpSecurity(server, {
    allowedOrigins: environment === "production"
      ? ["https://frontend.example"]
      : ["http://localhost:5173"],
    environment,
    rateLimit: { enabled: rateLimitEnabled },
  });
  registerAuthRoutes(server, {
    service,
    guard,
    environment,
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

      const duplicate = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      expect(duplicate.statusCode).toBe(409);

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
      expect(logout.headers["set-cookie"]).toContain("Path=/auth");
      expect(logout.headers["set-cookie"]).toContain("HttpOnly");
      expect(logout.headers["set-cookie"]).toContain("SameSite=Lax");
      expect([...harness.sessionRecords.values()][0]?.revokedAt)
        .toBeInstanceOf(Date);
    } finally {
      await server.close();
    }
  });

  it("detects replay through HTTP and invalidates the device session", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      const csrf = await csrfHeaders(server);
      const registration = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: csrf,
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      const setCookie = registration.headers["set-cookie"];
      const originalCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
        ?.split(";")[0];

      const rotateCsrf = await csrfHeaders(server);
      const rotated = await server.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: {
          ...rotateCsrf,
          cookie: `${rotateCsrf.cookie}; ${originalCookie}`,
        },
      });
      expect(rotated.statusCode).toBe(200);

      const replayCsrf = await csrfHeaders(server);
      const replay = await server.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: {
          ...replayCsrf,
          cookie: `${replayCsrf.cookie}; ${originalCookie}`,
        },
      });
      expect(replay.statusCode).toBe(401);
      expect([...harness.sessionRecords.values()][0]?.revokedAt)
        .toBeInstanceOf(Date);
      expect(harness.securityEvents).toContainEqual(
        expect.objectContaining({
          type: "refresh.replay_detected",
          sessionId: "session-1",
        }),
      );
      expect(JSON.stringify(harness.securityEvents)).not.toContain("refresh-1");

      const accessToken = rotated.json<{ accessToken: string }>().accessToken;
      const protectedResponse = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(protectedResponse.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("permits only one of two concurrent refresh requests and revokes the family", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      const csrf = await csrfHeaders(server);
      const registration = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: csrf,
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      const setCookie = registration.headers["set-cookie"];
      const originalCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
        ?.split(";")[0];

      const firstCsrf = await csrfHeaders(server);
      const secondCsrf = await csrfHeaders(server);
      const [first, second] = await Promise.all([
        server.inject({
          method: "POST",
          url: "/auth/refresh",
          headers: {
            ...firstCsrf,
            cookie: `${firstCsrf.cookie}; ${originalCookie}`,
          },
        }),
        server.inject({
          method: "POST",
          url: "/auth/refresh",
          headers: {
            ...secondCsrf,
            cookie: `${secondCsrf.cookie}; ${originalCookie}`,
          },
        }),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 401]);
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
      expect(logoutAll.headers["set-cookie"]).toContain("refresh_token=;");
      expect(logoutAll.headers["set-cookie"]).toContain("Path=/auth");
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

      const wrongPassword = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: await csrfHeaders(server),
        payload: {
          email: "missing@example.com",
          password: "a different valid passphrase",
        },
      });
      expect(wrongPassword.statusCode).toBe(401);
      expect(wrongPassword.json()).toMatchObject({
        error: { code: "AUTH_INVALID_CREDENTIALS" },
      });

      const extraProperties = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "valid@example.com",
          password: "a secure passphrase 123",
          passwordHash: "client-hash",
          role: "admin",
        },
      });
      expect(extraProperties.statusCode).toBe(400);

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

      const invalidCsrf = await csrfHeaders(server);
      const invalidCsrfResponse = await server.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: {
          ...invalidCsrf,
          "x-csrf-token": "invalid-csrf-token",
        },
      });
      expect(invalidCsrfResponse.statusCode).toBe(403);

      const missingRefreshCookie = await server.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: await csrfHeaders(server),
      });
      expect(missingRefreshCookie.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("rate limits refresh requests", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness, true);

    try {
      const csrf = await csrfHeaders(server);
      const responses = [];
      for (let index = 0; index < 11; index += 1) {
        responses.push(await server.inject({
          method: "POST",
          url: "/auth/refresh",
          headers: csrf,
        }));
      }

      expect(responses.slice(0, 10).every((response) =>
        response.statusCode === 401
      )).toBe(true);
      expect(responses[10]?.statusCode).toBe(429);
    } finally {
      await server.close();
    }
  });

  it("allows only one concurrent registration for a normalized email", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      const csrf = await csrfHeaders(server);
      const request = () => server.inject({
        method: "POST",
        url: "/auth/register",
        headers: csrf,
        payload: {
          email: " Concurrent@Example.com ",
          password: "a secure passphrase 123",
        },
      });
      const responses = await Promise.all([request(), request()]);

      expect(responses.map((response) => response.statusCode).sort())
        .toEqual([201, 409]);
      expect(harness.usersByEmail.size).toBe(1);
      expect(harness.sessionRecords.size).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("sets Secure on refresh cookies in production", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness, false, "production");

    try {
      const registration = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "secure@example.com",
          password: "a secure passphrase 123",
        },
      });

      expect(registration.statusCode).toBe(201);
      expect(registration.headers["set-cookie"]).toContain("Secure");
      expect(registration.headers["set-cookie"]).toContain("Path=/auth");
      expect(registration.headers["set-cookie"]).toContain("SameSite=Lax");
      expect(registration.headers["set-cookie"]).toContain("HttpOnly");
    } finally {
      await server.close();
    }
  });

  it("does not expose repository failure details in HTTP responses", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);
    harness.sessions.create = async () => {
      throw new Error("sensitive-refresh-token-or-database-detail");
    };

    try {
      const response = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "storage-error@example.com",
          password: "a secure passphrase 123",
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "INTERNAL_ERROR",
          message: "Authentication request failed.",
        },
      });
      expect(response.body).not.toContain("sensitive-refresh-token");
      expect(response.body).not.toContain("database-detail");
    } finally {
      await server.close();
    }
  });
});
