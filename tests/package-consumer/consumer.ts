import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { createBackend } from "@sethi-backend/core";
import { loadConfig } from "@sethi-backend/config";
import {
  createCsrfProtectionHook,
  createFastifyAdapter,
  generateCsrfToken,
  registerHttpSecurity,
} from "@sethi-backend/adapter-fastify";
import {
  createAuthService,
  createAuthenticationGuard,
  roleHasPermission,
} from "@sethi-backend/auth";
import {
  createMongoAuthActionTokenRepository,
  createMongoAuthSessionRepository,
  createMongoAuthUserRepository,
  createMongoDatabaseAdapter,
} from "@sethi-backend/database-mongodb";
import { createSmtpEmailSender } from "@sethi-backend/email";
import { createPasswordHasher, createTokenService } from "@sethi-backend/security";

const config = loadConfig(z.object({
  TEST_MONGODB_URI: z.string().min(1),
  TEST_MONGODB_DATABASE: z.string().regex(/_integration_test$/),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1),
  SMTP_SECURE: z.enum(["true", "false"]),
  EMAIL_FROM: z.string().min(1),
  TEST_SMTP_RECIPIENT: z.string().email(),
  MAILPIT_API_URL: z.string().url(),
}), process.env);

const database = createMongoDatabaseAdapter({
  uri: config.TEST_MONGODB_URI,
  databaseName: config.TEST_MONGODB_DATABASE,
  clientOptions: { serverSelectionTimeoutMS: 3000 },
});
const adapter = createFastifyAdapter();
const application = createBackend({
  server: { host: "127.0.0.1", port: 0 },
  database,
  adapter,
});
const users = createMongoAuthUserRepository({
  getDatabase: database.getDatabase,
  getClient: database.getClient,
});
const sessions = createMongoAuthSessionRepository({
  getDatabase: database.getDatabase,
});
const actionTokens = createMongoAuthActionTokenRepository({
  getDatabase: database.getDatabase,
  getClient: database.getClient,
});
const tokens = createTokenService({
  secret: randomBytes(48).toString("base64url"),
  issuer: "installed-consumer-test",
  audience: "installed-consumer-test",
});
const authService = await createAuthService({
  users,
  sessions,
  actionTokens,
  tokens,
  passwordHasher: createPasswordHasher(),
  emailSender: createSmtpEmailSender({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE === "true",
    from: config.EMAIL_FROM,
  }),
  appBaseUrl: "https://consumer.example.test",
});
const guard = createAuthenticationGuard({ users, sessions, tokens });
const csrfProtection = createCsrfProtectionHook(adapter.instance);

registerHttpSecurity(adapter.instance, {
  allowedOrigins: ["http://localhost:5173"],
  environment: "test",
});
adapter.instance.get("/csrf-token", async (_request, reply) => ({
  token: generateCsrfToken(reply),
}));
adapter.instance.get("/health", async (_request, reply) => {
  await database.getDatabase().command({ ping: 1 });
  return reply.code(200).send({ status: "ok" });
});
adapter.instance.post("/auth/register", {
  onRequest: csrfProtection,
}, async (request, reply) => {
  await authService.register(request.body);
  return reply.code(202).send();
});
adapter.instance.post("/auth/verify-email", async (request, reply) => {
  await authService.verifyEmail(request.body);
  return reply.code(204).send();
});
adapter.instance.post("/auth/login", {
  onRequest: csrfProtection,
}, async (request, reply) => {
  const result = await authService.login(request.body);
  return reply.send({ accessToken: result.accessToken, user: result.user });
});
adapter.instance.get("/auth/me", async (request, reply) => {
  const user = await guard.authenticate(request.headers.authorization);
  return reply.send({ user: { id: user.id, email: user.email } });
});
adapter.instance.get("/admin/check", async (request, reply) => {
  const user = await guard.authenticate(request.headers.authorization);
  if (!roleHasPermission(user.role, "roles:manage")) {
    return reply.code(403).send({ error: "Forbidden" });
  }
  return reply.send({ status: "authorized" });
});

function assertStatus(response: Response, expected: number): void {
  if (response.status !== expected) {
    throw new Error(
      `Installed consumer endpoint returned ${response.status}; expected ${expected}.`,
    );
  }
}

async function getCsrfHeaders(): Promise<{
  cookie: string;
  "x-csrf-token": string;
}> {
  const response = await fetch(`${baseUrl}/csrf-token`);
  assertStatus(response, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) {
    throw new Error("Installed API did not set a CSRF cookie.");
  }
  return {
    cookie,
    "x-csrf-token": (await response.json() as { token: string }).token,
  };
}

async function waitForVerificationToken(email: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      new URL("/api/v1/messages?start=0&limit=100", config.MAILPIT_API_URL),
    );
    if (!response.ok) {
      throw new Error(`Mailpit returned HTTP ${response.status}.`);
    }
    const result = await response.json() as {
      messages?: Array<{ ID: string; Subject: string; To: unknown }>;
    };
    const summary = result.messages?.find((message) =>
      message.Subject === "Verify your email address" &&
      JSON.stringify(message.To).includes(email)
    );
    if (summary) {
      const messageResponse = await fetch(
        new URL(
          `/api/v1/message/${encodeURIComponent(summary.ID)}`,
          config.MAILPIT_API_URL,
        ),
      );
      if (!messageResponse.ok) {
        throw new Error(`Mailpit returned HTTP ${messageResponse.status}.`);
      }
      const message = await messageResponse.json() as { HTML?: string };
      const href = message.HTML?.match(/href="([^"]+)"/)?.[1];
      if (href) {
        const token = new URL(href).hash.slice(1);
        const value = new URLSearchParams(token).get("token");
        if (value) {
          return value;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The installed SMTP package did not deliver a verification email.");
}

await database.connect();
let started = false;
let baseUrl = "";
try {
  await Promise.all([
    users.ensureIndexes(),
    sessions.ensureIndexes(),
    actionTokens.ensureIndexes(),
  ]);
  await application.start();
  started = true;
  const address = adapter.instance.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Installed Fastify API did not bind a TCP port.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/health`);
  assertStatus(health, 200);
  if ((await health.json() as { status: string }).status !== "ok") {
    throw new Error("Installed API health endpoint returned an unexpected response.");
  }

  const email = `consumer-${randomUUID()}@example.test`;
  const password = "installed consumer test passphrase 123";
  const registration = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...await getCsrfHeaders(),
    },
    body: JSON.stringify({ email, password }),
  });
  assertStatus(registration, 202);
  const verificationToken = await waitForVerificationToken(email);
  const verification = await fetch(`${baseUrl}/auth/verify-email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: verificationToken }),
  });
  assertStatus(verification, 204);

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...await getCsrfHeaders(),
    },
    body: JSON.stringify({ email, password }),
  });
  assertStatus(login, 200);
  const userSession = await login.json() as {
    accessToken: string;
    user: { id: string };
  };
  const profile = await fetch(`${baseUrl}/auth/me`, {
    headers: { authorization: `Bearer ${userSession.accessToken}` },
  });
  assertStatus(profile, 200);
  const regularUserAdminAccess = await fetch(`${baseUrl}/admin/check`, {
    headers: { authorization: `Bearer ${userSession.accessToken}` },
  });
  assertStatus(regularUserAdminAccess, 403);

  const promoted = await users.setRole(
    userSession.user.id,
    "admin",
    new Date(),
    null,
  );
  if (promoted.status !== "updated") {
    throw new Error("Installed MongoDB package failed to promote the verified user.");
  }
  const adminLogin = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...await getCsrfHeaders(),
    },
    body: JSON.stringify({ email, password }),
  });
  assertStatus(adminLogin, 200);
  const adminSession = await adminLogin.json() as { accessToken: string };
  const adminAccess = await fetch(`${baseUrl}/admin/check`, {
    headers: { authorization: `Bearer ${adminSession.accessToken}` },
  });
  assertStatus(adminAccess, 200);

  process.stdout.write(
    "Installed consumer passed MongoDB health, SMTP verification, login, profile, and RBAC checks.\n",
  );
} finally {
  try {
    await database.getDatabase().dropDatabase();
  } finally {
    if (started) {
      await application.stop();
    } else {
      await database.disconnect();
    }
  }
}
