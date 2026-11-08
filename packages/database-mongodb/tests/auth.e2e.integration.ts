import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { MongoClient, type Db } from "mongodb";

import {
  createAuthService,
  createAuthenticationGuard,
  type EmailMessage,
} from "@sethi-backend/auth";
import {
  createPasswordHasher,
  createTokenService,
} from "@sethi-backend/security";
import {
  createCsrfProtectionHook,
  createFastifyAdapter,
  generateCsrfToken,
  registerHttpSecurity,
} from "@sethi-backend/adapter-fastify";
import {
  createMongoAuthActionTokenRepository,
  createMongoAuthSessionRepository,
  createMongoAuthUserRepository,
} from "@sethi-backend/database-mongodb";
import { registerAdminRoutes } from "../../../examples/basic-api/src/admin-routes.js";
import { registerAuthRoutes } from "../../../examples/basic-api/src/auth-routes.js";

const mongoUri = process.env.TEST_MONGODB_URI;
const configuredDatabase = process.env.TEST_MONGODB_DATABASE;

if (Boolean(mongoUri) !== Boolean(configuredDatabase)) {
  throw new Error(
    "Set both TEST_MONGODB_URI and TEST_MONGODB_DATABASE to run real HTTP integration tests.",
  );
}

function assertSafeTestTarget(uri: string, databaseName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("TEST_MONGODB_URI must be a valid MongoDB URI.");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    parsed.protocol !== "mongodb:" ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "MongoDB HTTP integration tests require a local mongodb:// URI without credentials.",
    );
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(
      "Real HTTP integration tests only run against a local MongoDB host.",
    );
  }
  if (!databaseName.endsWith("_integration_test")) {
    throw new Error(
      "TEST_MONGODB_DATABASE must end with _integration_test.",
    );
  }
  if (databaseName.length > 46) {
    throw new Error("TEST_MONGODB_DATABASE must be at most 46 characters.");
  }
}

if (mongoUri && configuredDatabase) {
  assertSafeTestTarget(mongoUri, configuredDatabase);
}

describe(
  "Real MongoDB HTTP authentication workflow",
  () => {
    let client: MongoClient | undefined;
    let database: Db;
    let databaseName: string;
    let server: ReturnType<typeof createFastifyAdapter>["instance"];
    let users: ReturnType<typeof createMongoAuthUserRepository>;
    let sessions: ReturnType<typeof createMongoAuthSessionRepository>;
    let actionTokens: ReturnType<typeof createMongoAuthActionTokenRepository>;
    let authService: Awaited<ReturnType<typeof createAuthService>>;
    let guard: ReturnType<typeof createAuthenticationGuard>;
    const emailMessages: EmailMessage[] = [];

    function currentRefreshCookie(
      response: { headers: Readonly<Record<string, unknown>> },
    ): string {
      const setCookie = response.headers["set-cookie"];
      const cookies = typeof setCookie === "string"
        ? [setCookie]
        : Array.isArray(setCookie)
        ? setCookie.filter((cookie): cookie is string => typeof cookie === "string")
        : [];
      const refreshCookie = cookies.find((cookie) =>
        cookie?.startsWith("refresh_token=")
      );
      if (!refreshCookie) {
        throw new Error("Expected an HttpOnly refresh-token cookie.");
      }
      return refreshCookie.split(";")[0]!;
    }

    async function csrfHeaders(refreshCookie?: string) {
      const response = await server.inject({
        method: "GET",
        url: "/csrf-token",
      });
      const setCookie = response.headers["set-cookie"];
      const csrfCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
        ?.split(";")[0];
      if (!csrfCookie) {
        throw new Error("Expected a CSRF cookie.");
      }
      return {
        cookie: [csrfCookie, refreshCookie].filter(Boolean).join("; "),
        "x-csrf-token": response.json<{ token: string }>().token,
      };
    }

    async function csrfPost(
      url: string,
      payload: Record<string, string>,
      refreshCookie?: string,
    ) {
      return server.inject({
        method: "POST",
        url,
        headers: await csrfHeaders(refreshCookie),
        payload,
      });
    }

    function actionToken(subject: string): string {
      const message = [...emailMessages].reverse().find((item) =>
        item.subject === subject
      );
      const href = message?.html.match(/href="([^"]+)"/)?.[1];
      if (!href) {
        throw new Error(`Expected an email link for "${subject}".`);
      }
      const link = new URL(href);
      expect(link.origin).toBe("https://frontend.example");
      expect(link.hash).toContain("token=");
      const token = new URLSearchParams(link.hash.slice(1))
        .get("token");
      if (!token) {
        throw new Error("Expected a token in the URL fragment.");
      }
      expect(message?.text).toContain(token);
      return token;
    }

    async function registerAndVerify(email: string, password: string) {
      const registration = await csrfPost("/auth/register", { email, password });
      expect(registration.statusCode).toBe(202);
      const token = actionToken("Verify your email address");
      const verification = await server.inject({
        method: "POST",
        url: "/auth/verify-email",
        payload: { token },
      });
      expect(verification.statusCode).toBe(204);
      return token;
    }

    beforeAll(async () => {
      if (!mongoUri || !configuredDatabase) {
        throw new Error("MongoDB integration configuration is missing.");
      }

      databaseName = `${configuredDatabase}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });
      await client.connect();
      database = client.db(databaseName);
      const getClient = () => {
        if (!client) {
          throw new Error("MongoDB integration client is not connected.");
        }
        return client;
      };
      users = createMongoAuthUserRepository({
        getDatabase: () => database,
        getClient,
      });
      sessions = createMongoAuthSessionRepository({ getDatabase: () => database });
      actionTokens = createMongoAuthActionTokenRepository({
        getDatabase: () => database,
        getClient,
      });
      await Promise.all([
        users.ensureIndexes(),
        sessions.ensureIndexes(),
        actionTokens.ensureIndexes(),
      ]);

      const tokens = createTokenService({
        secret: randomBytes(48).toString("base64url"),
        issuer: "integration-test",
        audience: "integration-test-api",
      });
      authService = await createAuthService({
        users,
        sessions,
        actionTokens,
        tokens,
        passwordHasher: createPasswordHasher(),
        emailSender: {
          send: async (message) => {
            emailMessages.push(message);
          },
        },
        appBaseUrl: "https://frontend.example",
      });
      guard = createAuthenticationGuard({ users, sessions, tokens });

      const adapter = createFastifyAdapter();
      server = adapter.instance;
      registerHttpSecurity(server, {
        allowedOrigins: ["http://localhost:5173"],
        environment: "test",
      });
      registerAuthRoutes(server, {
        service: authService,
        guard,
        environment: "test",
        csrfProtection: createCsrfProtectionHook(server),
      });
      registerAdminRoutes(server, { guard, users, service: authService });
      server.get("/csrf-token", async (_request, reply) => ({
        token: generateCsrfToken(reply),
      }));
      await server.ready();
    }, 60_000);

    afterAll(async () => {
      await server?.close();
      if (client) {
        try {
          if (databaseName) {
            await client.db(databaseName).dropDatabase();
          }
        } finally {
          await client.close();
        }
      }
    });

    it("completes HTTP verification, sessions, reset, RBAC, and logout", async () => {
      const userEmail = `e2e-${randomUUID()}@example.com`;
      const oldPassword = "a secure integration passphrase 123";
      const newPassword = "a different integration passphrase 456";
      const verificationToken = await registerAndVerify(
        userEmail,
        oldPassword,
      );
      const replayedVerification = await server.inject({
        method: "POST",
        url: "/auth/verify-email",
        payload: { token: verificationToken },
      });
      expect(replayedVerification.statusCode).toBe(400);

      const firstLogin = await csrfPost("/auth/login", {
        email: userEmail,
        password: oldPassword,
      });
      expect(firstLogin.statusCode).toBe(200);
      const firstLoginBody = firstLogin.json<{
        accessToken: string;
        user: { id: string; email: string };
      }>();
      const firstRefreshCookie = currentRefreshCookie(firstLogin);

      const profile = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${firstLoginBody.accessToken}` },
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.json()).toMatchObject({ user: { email: userEmail } });

      const deniedBeforePromotion = await server.inject({
        method: "GET",
        url: "/admin/users",
        headers: { authorization: `Bearer ${firstLoginBody.accessToken}` },
      });
      expect(deniedBeforePromotion.statusCode).toBe(403);

      const refreshed = await csrfPost(
        "/auth/refresh",
        {},
        firstRefreshCookie,
      );
      expect(refreshed.statusCode).toBe(200);
      const refreshedBody = refreshed.json<{ accessToken: string }>();
      const rotatedRefreshCookie = currentRefreshCookie(refreshed);
      expect(rotatedRefreshCookie).not.toBe(firstRefreshCookie);

      const secondLogin = await csrfPost("/auth/login", {
        email: userEmail,
        password: oldPassword,
      });
      expect(secondLogin.statusCode).toBe(200);
      const secondLoginBody = secondLogin.json<{ accessToken: string }>();
      const secondRefreshCookie = currentRefreshCookie(secondLogin);

      const expiredToken = randomBytes(32).toString("base64url");
      const user = await users.findById(firstLoginBody.user.id);
      if (!user) {
        throw new Error("Registered integration user was not persisted.");
      }
      const expiredAt = new Date(Date.now() - 60_000);
      await actionTokens.replaceForUser({
        userId: user.id,
        tokenHash: createHash("sha256").update(expiredToken).digest("hex"),
        purpose: "password-reset",
        expiresAt: expiredAt,
        consumedAt: null,
        createdAt: expiredAt,
      });
      const expiredReset = await server.inject({
        method: "POST",
        url: "/auth/reset-password",
        payload: { token: expiredToken, newPassword },
      });
      expect(expiredReset.statusCode).toBe(400);

      const resetRequest = await server.inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { email: userEmail },
      });
      expect(resetRequest.statusCode).toBe(202);
      const resetToken = actionToken("Reset your password");
      const resetResponses = await Promise.all([
        server.inject({
          method: "POST",
          url: "/auth/reset-password",
          payload: { token: resetToken, newPassword },
        }),
        server.inject({
          method: "POST",
          url: "/auth/reset-password",
          payload: { token: resetToken, newPassword },
        }),
      ]);
      expect(resetResponses.map((response) => response.statusCode).sort())
        .toEqual([204, 400]);

      const revokedProfile = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${refreshedBody.accessToken}` },
      });
      expect(revokedProfile.statusCode).toBe(401);
      const revokedRefreshes = await Promise.all([
        csrfPost(
          "/auth/refresh",
          {},
          rotatedRefreshCookie,
        ),
        csrfPost(
          "/auth/refresh",
          {},
          secondRefreshCookie,
        ),
      ]);
      expect(revokedRefreshes.map((response) => response.statusCode))
        .toEqual([401, 401]);
      const revokedSecondProfile = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: {
          authorization: `Bearer ${secondLoginBody.accessToken}`,
        },
      });
      expect(revokedSecondProfile.statusCode).toBe(401);

      const rejectedOldPassword = await csrfPost("/auth/login", {
        email: userEmail,
        password: oldPassword,
      });
      expect(rejectedOldPassword.statusCode).toBe(401);
      const newLogin = await csrfPost("/auth/login", {
        email: userEmail,
        password: newPassword,
      });
      expect(newLogin.statusCode).toBe(200);
      const newLoginBody = newLogin.json<{ accessToken: string; user: { id: string } }>();
      const userRefreshCookie = currentRefreshCookie(newLogin);

      const adminEmail = `admin-${randomUUID()}@example.com`;
      const adminPassword = "admin integration passphrase 789";
      await registerAndVerify(adminEmail, adminPassword);
      const adminUser = await users.findByEmail(adminEmail);
      if (!adminUser) {
        throw new Error("Verified integration administrator was not persisted.");
      }
      await expect(users.setRole(adminUser.id, "admin", new Date(), null))
        .resolves.toMatchObject({ status: "updated" });
      const adminLogin = await csrfPost("/auth/login", {
        email: adminEmail,
        password: adminPassword,
      });
      expect(adminLogin.statusCode).toBe(200);
      const adminAccessToken = adminLogin.json<{ accessToken: string }>()
        .accessToken;
      const adminHeaders = {
        authorization: `Bearer ${adminAccessToken}`,
      };
      const adminUserList = await server.inject({
        method: "GET",
        url: "/admin/users",
        headers: adminHeaders,
      });
      expect(adminUserList.statusCode).toBe(200);

      const roleChange = await server.inject({
        method: "PATCH",
        url: `/admin/users/${newLoginBody.user.id}/role`,
        headers: adminHeaders,
        payload: { role: "moderator" },
      });
      expect(roleChange.statusCode).toBe(204);
      const moderatorAccess = await server.inject({
        method: "GET",
        url: "/admin/users",
        headers: {
          authorization: `Bearer ${newLoginBody.accessToken}`,
        },
      });
      expect(moderatorAccess.statusCode).toBe(200);

      const demotion = await server.inject({
        method: "PATCH",
        url: `/admin/users/${newLoginBody.user.id}/role`,
        headers: adminHeaders,
        payload: { role: "user" },
      });
      expect(demotion.statusCode).toBe(204);
      const accessAfterDemotion = await server.inject({
        method: "GET",
        url: "/admin/users",
        headers: {
          authorization: `Bearer ${newLoginBody.accessToken}`,
        },
      });
      expect(accessAfterDemotion.statusCode).toBe(403);

      const logout = await csrfPost(
        "/auth/logout",
        {},
        userRefreshCookie,
      );
      expect(logout.statusCode).toBe(204);
      const refreshAfterLogout = await csrfPost(
        "/auth/refresh",
        {},
        userRefreshCookie,
      );
      expect(refreshAfterLogout.statusCode).toBe(401);
    }, 90_000);
  },
);
