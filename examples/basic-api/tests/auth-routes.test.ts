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
  type AuthActionTokenRecord,
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
import { registerAdminRoutes } from "../src/admin-routes.js";

function createAuthHarness() {
  const records = new Map<string, AuthUserRecord>();
  const byEmail = new Map<string, AuthUserRecord>();
  const sessions = new Map<string, AuthSessionRecord>();
  const consumedHashes = new Map<string, string[]>();
  const securityEvents: Array<Record<string, unknown>> = [];
  const actionRecords = new Map<string, AuthActionTokenRecord>();
  const emailMessages: Array<{ to: string; subject: string; text: string; html: string }> = [];
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
    list: async () => [...records.values()].map(({ passwordHash: _hash, ...user }) => user),
    setRole: async (userId, role, updatedAt, actorUserId) => {
      if (actorUserId === userId) {
        return { status: "actor_not_admin" as const };
      }
      if (actorUserId) {
        const actor = records.get(actorUserId);
        if (actor?.role !== "admin") {
          return { status: "actor_not_admin" as const };
        }
      }
      const target = records.get(userId);
      if (!target) {
        return { status: "not_found" as const };
      }
      if (target.role === "admin" && role !== "admin") {
        const admins = [...records.values()].filter((user) => user.role === "admin");
        if (admins.length <= 1) {
          return { status: "last_admin" as const };
        }
      }
      const previousRole = target.role;
      target.role = role;
      target.updatedAt = updatedAt;
      return {
        status: "updated" as const,
        user: (({ passwordHash: _hash, ...user }) => user)(target),
        previousRole,
      };
    },
  };
  const actionTokens = {
    ensureIndexes: async () => undefined,
    replaceForUser: async (input: AuthActionTokenRecord) => {
      actionRecords.set(`${input.userId}:${input.purpose}`, input);
    },
    findByHash: async (tokenHash: string) =>
      [...actionRecords.values()].find((record) => record.tokenHash === tokenHash) ?? null,
    verifyEmail: async (tokenHash: string, now: Date) => {
      const record = [...actionRecords.values()].find((candidate) =>
        candidate.tokenHash === tokenHash &&
        candidate.purpose === "email-verification" &&
        candidate.consumedAt === null &&
        candidate.expiresAt > now
      );
      if (!record) {
        return false;
      }
      record.consumedAt = now;
      const user = records.get(record.userId);
      if (!user || user.emailVerified) {
        return false;
      }
      user.emailVerified = true;
      user.emailVerifiedAt = now;
      return true;
    },
    resetPassword: async (input: {
      tokenHash: string;
      passwordHash: string;
      now: Date;
    }) => {
      const record = [...actionRecords.values()].find((candidate) =>
        candidate.tokenHash === input.tokenHash &&
        candidate.purpose === "password-reset" &&
        candidate.consumedAt === null &&
        candidate.expiresAt > input.now
      );
      if (!record) {
        return false;
      }
      const user = records.get(record.userId);
      if (!user) {
        return false;
      }
      record.consumedAt = input.now;
      user.passwordHash = input.passwordHash;
      for (const session of sessions.values()) {
        if (session.userId === user.id) {
          session.revokedAt = input.now;
        }
      }
      return true;
    },
  };
  const emailSender = {
    send: async (message: typeof emailMessages[number]) => {
      emailMessages.push(message);
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
    actionTokens,
    actionRecords,
    emailMessages,
    emailSender,
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

function emailToken(
  harness: ReturnType<typeof createAuthHarness>,
  index = -1,
): string {
  const message = harness.emailMessages.at(index);
  const href = message?.html.match(/href="([^"]+)"/)?.[1];
  if (!href) {
    throw new Error("Expected an email action link.");
  }
  const token = new URLSearchParams(new URL(href).hash.slice(1)).get("token");
  if (!token) {
    throw new Error("Expected a token in the URL fragment.");
  }
  return token;
}

async function registerAndLogin(
  server: ReturnType<typeof Fastify>,
  harness: ReturnType<typeof createAuthHarness>,
  email = "user@example.com",
  password = "a secure passphrase 123",
) {
  const registration = await server.inject({
    method: "POST",
    url: "/auth/register",
    headers: await csrfHeaders(server),
    payload: { email, password },
  });
  if (registration.statusCode !== 202) {
    throw new Error(`Registration failed with HTTP ${registration.statusCode}.`);
  }
  const verification = await server.inject({
    method: "POST",
    url: "/auth/verify-email",
    payload: { token: emailToken(harness) },
  });
  if (verification.statusCode !== 204) {
    throw new Error(`Email verification failed with HTTP ${verification.statusCode}.`);
  }
  return server.inject({
    method: "POST",
    url: "/auth/login",
    headers: await csrfHeaders(server),
    payload: { email, password },
  });
}

async function createServer(
  harness: ReturnType<typeof createAuthHarness>,
  rateLimitEnabled = false,
  environment: "test" | "production" = "test",
) {
  const service = await createAuthService({
    ...harness,
    emailSender: harness.emailSender,
    appBaseUrl: "https://frontend.example",
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
  registerAdminRoutes(server, {
    guard,
    users: harness.users,
    service,
  });
  server.get("/csrf-token", async (_request, reply) => {
    return { token: generateCsrfToken(reply) };
  });
  return server;
}

describe("Basic API auth routes", () => {
  it("requires email verification before login and protects profile data", async () => {
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

      expect(registration.statusCode, registration.body).toBe(202);
      expect(registration.json()).toEqual({
        message: "If registration can be completed, verification instructions will be sent.",
      });
      expect(registration.body).not.toContain("refreshToken");
      expect(harness.usersByEmail.get("user@example.com")).toMatchObject({
        emailVerified: false,
        role: "user",
      });
      expect(harness.emailMessages[0]?.subject).toBe("Verify your email address");

      const duplicate = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      expect(duplicate.statusCode).toBe(registration.statusCode);
      expect(duplicate.body).toBe(registration.body);

      const unverifiedLogin = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: await csrfHeaders(server),
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      expect(unverifiedLogin.statusCode).toBe(401);

      const verification = await server.inject({
        method: "POST",
        url: "/auth/verify-email",
        payload: { token: emailToken(harness) },
      });
      expect(verification.statusCode).toBe(204);

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
      const loginCookie = login.headers["set-cookie"];
      expect(loginCookie).toContain("HttpOnly");
      expect(loginCookie).toContain("refresh_token=refresh-1");

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
      const login = await registerAndLogin(server, harness);
      const loginCookie = login.headers["set-cookie"];
      const cookieHeader = (Array.isArray(loginCookie)
        ? loginCookie[0]
        : loginCookie)?.split(";")[0];

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
      const login = await registerAndLogin(server, harness);
      const setCookie = login.headers["set-cookie"];
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
      const login = await registerAndLogin(server, harness);
      const setCookie = login.headers["set-cookie"];
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
      const login = await registerAndLogin(server, harness);
      const accessToken = login.json<{ accessToken: string }>().accessToken;
      expect(harness.sessionRecords.size).toBe(1);

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

  it("replaces verification tokens, rejects expiration and permits only one consumption", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "verify@example.com",
          password: "a secure passphrase 123",
        },
      });
      const firstToken = emailToken(harness);
      const unknownResend = await server.inject({
        method: "POST",
        url: "/auth/resend-verification",
        payload: { email: "missing@example.com" },
      });
      const resend = await server.inject({
        method: "POST",
        url: "/auth/resend-verification",
        payload: { email: "VERIFY@example.com" },
      });
      expect(resend.statusCode).toBe(202);
      expect(resend.body).toBe(unknownResend.body);
      const secondToken = emailToken(harness);
      expect(secondToken).not.toBe(firstToken);

      const stale = await server.inject({
        method: "POST",
        url: "/auth/verify-email",
        payload: { token: firstToken },
      });
      expect(stale.statusCode).toBe(400);

      const expiredUser = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "expired@example.com",
          password: "a secure passphrase 123",
        },
      });
      expect(expiredUser.statusCode).toBe(202);
      const expiredToken = emailToken(harness);
      const expiredRecord = harness.actionRecords.get("user-2:email-verification");
      if (!expiredRecord) {
        throw new Error("Expected persisted verification token.");
      }
      expiredRecord.expiresAt = new Date(Date.now() - 1);
      const expired = await server.inject({
        method: "POST",
        url: "/auth/verify-email",
        payload: { token: expiredToken },
      });
      expect(expired.statusCode).toBe(400);

      const current = await server.inject({
        method: "POST",
        url: "/auth/verify-email",
        payload: { token: secondToken },
      });
      expect(current.statusCode).toBe(204);
      expect(harness.usersByEmail.get("verify@example.com")?.emailVerifiedAt)
        .toBeInstanceOf(Date);
      const replay = await server.inject({
        method: "POST",
        url: "/auth/verify-email",
        payload: { token: secondToken },
      });
      expect(replay.statusCode).toBe(400);

      const verifiedResend = await server.inject({
        method: "POST",
        url: "/auth/resend-verification",
        payload: { email: "verify@example.com" },
      });
      expect(verifiedResend.body).toBe(unknownResend.body);
    } finally {
      await server.close();
    }
  });

  it("returns a generic forgot-password response and atomically revokes sessions on reset", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      const login = await registerAndLogin(server, harness);
      const accessToken = login.json<{ accessToken: string }>().accessToken;
      const currentCookie = login.headers["set-cookie"];
      const cookieHeader = (Array.isArray(currentCookie)
        ? currentCookie[0]
        : currentCookie)?.split(";")[0];

      const known = await server.inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { email: "user@example.com" },
      });
      const unknown = await server.inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { email: "missing@example.com" },
      });
      expect(known.statusCode).toBe(202);
      expect(known.body).toBe(unknown.body);
      expect(harness.emailMessages.at(-1)?.subject).toBe("Reset your password");
      const token = emailToken(harness);

      const reset = await server.inject({
        method: "POST",
        url: "/auth/reset-password",
        payload: {
          token,
          newPassword: "a completely new secure passphrase 456",
        },
      });
      expect(reset.statusCode).toBe(204);
      expect(reset.headers["set-cookie"]).toContain("refresh_token=;");
      expect([...harness.sessionRecords.values()].every((session) =>
        session.revokedAt instanceof Date
      )).toBe(true);

      const staleAccess = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(staleAccess.statusCode).toBe(401);

      const staleRefreshCsrf = await csrfHeaders(server);
      const staleRefresh = await server.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: {
          ...staleRefreshCsrf,
          cookie: `${staleRefreshCsrf.cookie}; ${cookieHeader}`,
        },
      });
      expect(staleRefresh.statusCode).toBe(401);

      const oldPassword = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: await csrfHeaders(server),
        payload: {
          email: "user@example.com",
          password: "a secure passphrase 123",
        },
      });
      const newPassword = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: await csrfHeaders(server),
        payload: {
          email: "user@example.com",
          password: "a completely new secure passphrase 456",
        },
      });
      expect(oldPassword.statusCode).toBe(401);
      expect(newPassword.statusCode).toBe(200);
      expect(harness.emailMessages.at(-1)?.subject).toBe("Your password was changed");

      const replay = await server.inject({
        method: "POST",
        url: "/auth/reset-password",
        payload: {
          token,
          newPassword: "yet another secure passphrase 789",
        },
      });
      expect(replay.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("allows only one concurrent password reset and keeps token delivery failures retryable", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      await registerAndLogin(server, harness);
      harness.emailSender.send = async () => {
        throw new Error("SMTP credentials and server details must not leak");
      };
      const response = await server.inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { email: "user@example.com" },
      });
      expect(response.statusCode).toBe(202);
      expect(response.body).toContain("If an account exists");

      harness.emailSender.send = async (message) => {
        harness.emailMessages.push(message);
      };
      await server.inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { email: "user@example.com" },
      });
      const token = emailToken(harness);
      const request = () => server.inject({
        method: "POST",
        url: "/auth/reset-password",
        payload: {
          token,
          newPassword: "a new concurrent secure password 456",
        },
      });
      const results = await Promise.all([request(), request()]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([204, 400]);
    } finally {
      await server.close();
    }
  });

  it("uses current persisted roles for admin routes and prevents self-role changes", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness);

    try {
      const unauthenticated = await server.inject({
        method: "GET",
        url: "/admin/dashboard",
      });
      expect(unauthenticated.statusCode).toBe(401);

      await registerAndLogin(
        server,
        harness,
        "admin@example.com",
      );
      const admin = harness.usersByEmail.get("admin@example.com");
      if (!admin) {
        throw new Error("Expected admin user record.");
      }
      admin.role = "admin";
      const currentAdminLogin = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: await csrfHeaders(server),
        payload: {
          email: "admin@example.com",
          password: "a secure passphrase 123",
        },
      });
      const adminToken = currentAdminLogin.json<{ accessToken: string }>().accessToken;
      const adminId = admin.id;
      const targetLogin = await registerAndLogin(
        server,
        harness,
        "target@example.com",
      );
      const targetId = harness.usersByEmail.get("target@example.com")!.id;

      const dashboard = await server.inject({
        method: "GET",
        url: "/admin/dashboard",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(dashboard.statusCode, dashboard.body).toBe(200);
      const targetUsersBefore = await server.inject({
        method: "GET",
        url: "/admin/users",
        headers: {
          authorization: `Bearer ${targetLogin.json<{ accessToken: string }>().accessToken}`,
        },
      });
      expect(targetUsersBefore.statusCode).toBe(403);
      const promoted = await server.inject({
        method: "PATCH",
        url: `/admin/users/${targetId}/role`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: "admin" },
      });
      expect(promoted.statusCode).toBe(204);
      expect(harness.usersByEmail.get("target@example.com")?.role).toBe("admin");

      const selfChange = await server.inject({
        method: "PATCH",
        url: `/admin/users/${adminId}/role`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { role: "user" },
      });
      expect(selfChange.statusCode).toBe(403);

      const staleClaimToken = targetLogin.json<{ accessToken: string }>().accessToken;
      const targetUsersAfterPromotion = await server.inject({
        method: "GET",
        url: "/admin/users",
        headers: { authorization: `Bearer ${staleClaimToken}` },
      });
      expect(targetUsersAfterPromotion.statusCode).toBe(200);
      const target = harness.usersByEmail.get("target@example.com")!;
      target.role = "moderator";
      const targetUsersAfter = await server.inject({
        method: "GET",
        url: "/admin/users",
        headers: { authorization: `Bearer ${staleClaimToken}` },
      });
      expect(targetUsersAfter.statusCode).toBe(200);
      const moderatorDashboard = await server.inject({
        method: "GET",
        url: "/admin/dashboard",
        headers: { authorization: `Bearer ${staleClaimToken}` },
      });
      expect(moderatorDashboard.statusCode).toBe(403);
      const moderatorRoleChange = await server.inject({
        method: "PATCH",
        url: `/admin/users/${adminId}/role`,
        headers: { authorization: `Bearer ${staleClaimToken}` },
        payload: { role: "admin" },
      });
      expect(moderatorRoleChange.statusCode).toBe(403);

      admin.role = "user";
      const revokedAdminToken = await server.inject({
        method: "GET",
        url: "/admin/dashboard",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(revokedAdminToken.statusCode).toBe(403);
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

  it("rate limits verification resends and password-reset requests", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness, true);

    try {
      const resendResponses = [];
      for (let index = 0; index < 4; index += 1) {
        resendResponses.push(await server.inject({
          method: "POST",
          url: "/auth/resend-verification",
          payload: { email: "missing@example.com" },
        }));
      }
      expect(resendResponses.slice(0, 3).every((response) =>
        response.statusCode === 202
      )).toBe(true);
      expect(resendResponses[3]?.statusCode).toBe(429);

      const resetResponses = [];
      for (let index = 0; index < 4; index += 1) {
        resetResponses.push(await server.inject({
          method: "POST",
          url: "/auth/forgot-password",
          payload: { email: "missing@example.com" },
        }));
      }
      expect(resetResponses.slice(0, 3).every((response) =>
        response.statusCode === 202
      )).toBe(true);
      expect(resetResponses[3]?.statusCode).toBe(429);
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
        .toEqual([202, 202]);
      expect(responses[0]?.body).toBe(responses[1]?.body);
      expect(harness.usersByEmail.size).toBe(1);
      expect(harness.sessionRecords.size).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("sets Secure on refresh cookies in production", async () => {
    const harness = createAuthHarness();
    const server = await createServer(harness, false, "production");

    try {
      const login = await registerAndLogin(
        server,
        harness,
        "secure@example.com",
      );

      expect(login.statusCode).toBe(200);
      expect(login.headers["set-cookie"]).toContain("Secure");
      expect(login.headers["set-cookie"]).toContain("Path=/auth");
      expect(login.headers["set-cookie"]).toContain("SameSite=Lax");
      expect(login.headers["set-cookie"]).toContain("HttpOnly");
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
      const registration = await server.inject({
        method: "POST",
        url: "/auth/register",
        headers: await csrfHeaders(server),
        payload: {
          email: "storage-error@example.com",
          password: "a secure passphrase 123",
        },
      });
      await server.inject({
        method: "POST",
        url: "/auth/verify-email",
        payload: { token: emailToken(harness) },
      });
      const response = await server.inject({
        method: "POST",
        url: "/auth/login",
        headers: await csrfHeaders(server),
        payload: {
          email: "storage-error@example.com",
          password: "a secure passphrase 123",
        },
      });

      expect(registration.statusCode).toBe(202);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
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
