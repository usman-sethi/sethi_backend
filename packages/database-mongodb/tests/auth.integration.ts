import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  MongoClient,
  ObjectId,
  type Db,
} from "mongodb";

import {
  createAuthService,
  createAuthenticationGuard,
  DuplicateUserError,
  InvalidActionTokenError,
  InvalidRefreshTokenError,
} from "@sethi-backend/auth";
import { createTokenService } from "@sethi-backend/security";
import {
  createMongoAuthSessionRepository,
  createMongoAuthActionTokenRepository,
  createMongoAuthUserRepository,
} from "@sethi-backend/database-mongodb";

const configuredUri = process.env.TEST_MONGODB_URI;
const configuredDatabase = process.env.TEST_MONGODB_DATABASE;

if (Boolean(configuredUri) !== Boolean(configuredDatabase)) {
  throw new Error(
    "Set both TEST_MONGODB_URI and TEST_MONGODB_DATABASE to run real MongoDB integration tests.",
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
      "MongoDB integration tests require a local mongodb:// URI without credentials.",
    );
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(
      "Real MongoDB integration tests only run against a local MongoDB host.",
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

if (configuredUri && configuredDatabase) {
  assertSafeTestTarget(configuredUri, configuredDatabase);
}

describe(
  "Real MongoDB authentication integration (TEST_MONGODB_URI required)",
  () => {
    let client: MongoClient | undefined;
    let connected = false;
    let database: Db;
    let databaseName: string;
    let users: ReturnType<typeof createMongoAuthUserRepository>;
    let sessions: ReturnType<typeof createMongoAuthSessionRepository>;
    let actionTokens: ReturnType<typeof createMongoAuthActionTokenRepository>;
    const emailMessages: Array<{ to: string; subject: string; text: string; html: string }> = [];
    const emailSender = {
      send: async (message: typeof emailMessages[number]) => {
        emailMessages.push(message);
      },
    };

    function getClient(): MongoClient {
      if (!client) {
        throw new Error("MongoDB integration client is not connected.");
      }
      return client;
    }

    beforeAll(async () => {
      if (!configuredUri || !configuredDatabase) {
        throw new Error("MongoDB integration configuration is missing.");
      }
      databaseName = `${configuredDatabase}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      client = new MongoClient(configuredUri, {
        serverSelectionTimeoutMS: 3000,
      });
      await client.connect();
      connected = true;
      database = client.db(databaseName);
      users = createMongoAuthUserRepository({
        getDatabase: () => database,
        getClient,
      });
      sessions = createMongoAuthSessionRepository({
        getDatabase: () => database,
      });
      actionTokens = createMongoAuthActionTokenRepository({
        getDatabase: () => database,
        getClient,
      });
      await Promise.all([
        users.ensureIndexes(),
        sessions.ensureIndexes(),
        actionTokens.ensureIndexes(),
      ]);
    });

    function emailToken(index = -1): string {
      const link = emailMessages.at(index)?.html.match(/href="([^"]+)"/)?.[1];
      if (!link) {
        throw new Error("Expected an email action link.");
      }
      const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
      if (!token) {
        throw new Error("Expected an action token in the URL fragment.");
      }
      return token;
    }

    async function createAuth() {
      const tokens = createTokenService({
        secret: randomBytes(48).toString("base64url"),
        issuer: "integration-test",
        audience: "integration-test-api",
      });
      const auth = await createAuthService({
        users,
        sessions,
        actionTokens,
        tokens,
        passwordHasher: {
          hash: async (value) => `$test-hash$${value}`,
          verify: async (value, hash) => hash === `$test-hash$${value}`,
        },
        emailSender,
        appBaseUrl: "https://frontend.example",
      });
      return { auth, tokens };
    }

    afterAll(async () => {
      if (client) {
        try {
          if (connected && databaseName) {
            await client.db(databaseName).dropDatabase();
          }
        } finally {
          await client.close();
        }
      }
    });

    it("persists normalized users with unique email and no plaintext password", async () => {
      const email = `user-${randomUUID()}@example.com`;
      const password = "integration-only password";
      const now = new Date();
      const created = await users.create({
        email,
        passwordHash: "test-password-hash",
        emailVerified: false,
        emailVerifiedAt: null,
        role: "user",
        createdAt: now,
        updatedAt: now,
      });

      expect(await users.findByEmail(email)).toMatchObject({
        id: created.id,
        email,
        passwordHash: "test-password-hash",
      });
      expect(await users.findById(created.id)).toMatchObject({
        id: created.id,
        email,
      });
      await expect(users.create({
        email,
        passwordHash: "another-test-password-hash",
        emailVerified: false,
        emailVerifiedAt: null,
        role: "user",
        createdAt: now,
        updatedAt: now,
      })).rejects.toBeInstanceOf(DuplicateUserError);

      const stored = await database.collection("auth_users").findOne({
        email,
      });
      expect(stored?.passwordHash).toBe("test-password-hash");
      expect(stored?.passwordHash).not.toBe(password);
      expect(stored).not.toHaveProperty("password");
    });

    it("rotates refresh tokens, detects replay, and rejects revoked access", async () => {
      const { auth, tokens } = await createAuth();
      const email = `flow-${randomUUID()}@example.com`;
      await auth.register({
        email,
        password: "integration-only password",
      });
      await auth.verifyEmail({ token: emailToken() });
      const registered = await auth.login({
        email,
        password: "integration-only password",
      });
      const sessionLookup = await sessions.findByRefreshTokenHash(
        tokens.hashRefreshToken(registered.refreshToken),
      );
      expect(sessionLookup?.status).toBe("current");
      if (!sessionLookup) {
        throw new Error("Expected persisted refresh session.");
      }
      const sessionId = sessionLookup.session.id;

      const rawTokenBefore = await database.collection("auth_sessions")
        .findOne({ _id: new ObjectId(sessionId) });
      expect(JSON.stringify(rawTokenBefore)).not.toContain(registered.refreshToken);
      expect(rawTokenBefore?.refreshTokenHash)
        .toBe(tokens.hashRefreshToken(registered.refreshToken));

      const rotated = await auth.refresh(registered.refreshToken);
      expect(rotated.refreshToken).not.toBe(registered.refreshToken);
      expect(
        (await sessions.findByRefreshTokenHash(
          tokens.hashRefreshToken(registered.refreshToken),
        ))?.status,
      ).toBe("consumed");
      expect(
        (await sessions.findByRefreshTokenHash(
          tokens.hashRefreshToken(rotated.refreshToken),
        ))?.status,
      ).toBe("current");

      const guard = createAuthenticationGuard({ users, sessions, tokens });
      await expect(guard.authenticate(`Bearer ${rotated.accessToken}`))
        .resolves.toMatchObject({ email: registered.user.email });
      await expect(auth.refresh(registered.refreshToken))
        .rejects.toBeInstanceOf(InvalidRefreshTokenError);
      await expect(guard.authenticate(`Bearer ${rotated.accessToken}`))
        .rejects.toThrow();
    });

    it("allows one concurrent consume and revokes the family on the competing reuse", async () => {
      const { auth, tokens } = await createAuth();
      const email = `race-${randomUUID()}@example.com`;
      await auth.register({
        email,
        password: "integration-only password",
      });
      await auth.verifyEmail({ token: emailToken() });
      const registered = await auth.login({
        email,
        password: "integration-only password",
      });

      const results = await Promise.allSettled([
        auth.refresh(registered.refreshToken),
        auth.refresh(registered.refreshToken),
      ]);
      expect(results.filter((result) => result.status === "fulfilled"))
        .toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected"))
        .toHaveLength(1);

      const sessionLookup = await sessions.findByRefreshTokenHash(
        tokens.hashRefreshToken(registered.refreshToken),
      );
      expect(sessionLookup?.status).toBe("consumed");
      expect(sessionLookup?.session.revokedAt).toBeInstanceOf(Date);
    });

    it("enforces owner-scoped and user-wide session revocation", async () => {
      const userA = await users.create({
        email: `owner-a-${randomUUID()}@example.com`,
        passwordHash: "hash-a",
        emailVerified: false,
        emailVerifiedAt: null,
        role: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const userB = await users.create({
        email: `owner-b-${randomUUID()}@example.com`,
        passwordHash: "hash-b",
        emailVerified: false,
        emailVerifiedAt: null,
        role: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60_000);
      const ownedSession = await sessions.create({
        userId: userB.id,
        refreshTokenHash: `hash-${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        expiresAt,
      });
      const userASession = await sessions.create({
        userId: userA.id,
        refreshTokenHash: `hash-${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        expiresAt,
      });

      await expect(
        sessions.revokeById(ownedSession.id, userA.id, now),
      ).resolves.toBe(false);
      expect((await sessions.findById(ownedSession.id))?.revokedAt).toBeNull();
      await expect(
        sessions.revokeById(ownedSession.id, userB.id, now),
      ).resolves.toBe(true);

      await sessions.revokeAllForUser(userA.id, now);
      expect((await sessions.findById(userASession.id))?.revokedAt).toEqual(now);

      const indexes = await database.collection("auth_sessions")
        .listIndexes().toArray();
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "auth_sessions_expiry_ttl",
          expireAfterSeconds: 0,
        }),
        expect.objectContaining({
          name: "auth_sessions_consumed_hash",
        }),
      ]));
    });

  it("persists hashed action tokens and transactionally resets password and sessions", async () => {
    const { auth, tokens } = await createAuth();
    const email = `reset-${randomUUID()}@example.com`;
    const oldPassword = "integration-only password";
    const newPassword = "integration-only replacement password";
    await auth.register({ email, password: oldPassword });
    const verificationToken = emailToken();
    const verificationHash = createHash("sha256")
      .update(verificationToken, "utf8")
      .digest("hex");
    const storedVerification = await database
      .collection("auth_action_tokens")
      .findOne({ tokenHash: verificationHash });
    expect(storedVerification).toMatchObject({
      purpose: "email-verification",
      consumedAt: null,
    });
    expect(JSON.stringify(storedVerification)).not.toContain(verificationToken);

    await auth.verifyEmail({ token: verificationToken });
    const login = await auth.login({ email, password: oldPassword });
    const accessToken = login.accessToken;
    const refreshHash = tokens.hashRefreshToken(login.refreshToken);
    const sessionLookup = await sessions.findByRefreshTokenHash(refreshHash);
    if (!sessionLookup) {
      throw new Error("Expected a persisted session before password reset.");
    }

    await auth.requestPasswordReset({ email });
    const resetToken = emailToken();
    const resetHash = createHash("sha256")
      .update(resetToken, "utf8")
      .digest("hex");
    const storedReset = await database
      .collection("auth_action_tokens")
      .findOne({ tokenHash: resetHash });
    expect(storedReset).toMatchObject({ purpose: "password-reset" });
    expect(JSON.stringify(storedReset)).not.toContain(resetToken);

    await auth.resetPassword({ token: resetToken, newPassword });
    expect((await sessions.findById(sessionLookup.session.id))?.revokedAt)
      .toBeInstanceOf(Date);
    const guard = createAuthenticationGuard({
      users,
      sessions,
      tokens,
    });
    await expect(guard.authenticate(`Bearer ${accessToken}`)).rejects.toThrow();
    await expect(auth.login({ email, password: oldPassword }))
      .rejects.toThrow();
    await expect(auth.login({ email, password: newPassword }))
      .resolves.toMatchObject({ user: { email } });
    await expect(auth.resetPassword({ token: resetToken, newPassword }))
      .rejects.toBeInstanceOf(InvalidActionTokenError);
  });

  it("audits role changes and prevents demoting the final administrator", async () => {
    const now = new Date();
    const administrator = await users.create({
      email: `admin-${randomUUID()}@example.com`,
      passwordHash: "admin-hash",
      emailVerified: false,
      emailVerifiedAt: null,
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    const target = await users.create({
      email: `target-${randomUUID()}@example.com`,
      passwordHash: "target-hash",
      emailVerified: false,
      emailVerifiedAt: null,
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    await database.collection("auth_users").updateMany(
      { _id: { $in: [new ObjectId(administrator.id), new ObjectId(target.id)] } },
      { $set: { emailVerified: true, emailVerifiedAt: now } },
    );
    await expect(users.setRole(administrator.id, "admin", now, null))
      .resolves.toMatchObject({ status: "updated" });
    await expect(users.setRole(target.id, "admin", now, administrator.id))
      .resolves.toMatchObject({ status: "updated" });
    await expect(users.setRole(administrator.id, "user", now, null))
      .resolves.toMatchObject({ status: "updated" });
    await expect(users.setRole(target.id, "user", now, null))
      .resolves.toMatchObject({ status: "last_admin" });

    const audit = await database.collection("auth_audit_logs").find({
      type: "user.role_changed",
    }).toArray();
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });



    it("revokes legacy sessions that lack replay history during repository setup", async () => {
      const user = await users.create({
        email: `legacy-${randomUUID()}@example.com`,
        passwordHash: "legacy-hash",
        emailVerified: false,
        emailVerifiedAt: null,
        role: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const legacyId = new ObjectId();
      const now = new Date();
      await database.collection("auth_sessions").insertOne({
        _id: legacyId,
        userId: new ObjectId(user.id),
        refreshTokenHash: `legacy-${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: null,
      });

      await sessions.ensureIndexes();

      const migrated = await sessions.findById(legacyId.toHexString());
      expect(migrated?.revokedAt).toBeInstanceOf(Date);
      expect(migrated?.rotationCount).toBe(0);
    });
  },
);
