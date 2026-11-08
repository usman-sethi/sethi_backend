import { randomBytes, randomUUID } from "node:crypto";
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
  InvalidRefreshTokenError,
} from "../../auth/src/index.js";
import { createTokenService } from "../../security/src/index.js";
import {
  createMongoAuthSessionRepository,
} from "../src/auth-session-repository.js";
import {
  createMongoAuthUserRepository,
} from "../src/auth-user-repository.js";

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

describe.skipIf(!configuredUri)(
  "Real MongoDB authentication integration (TEST_MONGODB_URI required)",
  () => {
    let client: MongoClient | undefined;
    let connected = false;
    let database: Db;
    let databaseName: string;
    let users: ReturnType<typeof createMongoAuthUserRepository>;
    let sessions: ReturnType<typeof createMongoAuthSessionRepository>;

    beforeAll(async () => {
      databaseName = `${configuredDatabase}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      client = new MongoClient(configuredUri!, {
        serverSelectionTimeoutMS: 3000,
      });
      await client.connect();
      connected = true;
      database = client.db(databaseName);
      users = createMongoAuthUserRepository({
        getDatabase: () => database,
      });
      sessions = createMongoAuthSessionRepository({
        getDatabase: () => database,
      });
      await Promise.all([
        users.ensureIndexes(),
        sessions.ensureIndexes(),
      ]);
    });

    afterAll(async () => {
      if (client) {
        if (connected && databaseName) {
          await client.db(databaseName).dropDatabase();
        }
        await client.close();
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
      const tokens = createTokenService({
        secret: randomBytes(48).toString("base64url"),
        issuer: "integration-test",
        audience: "integration-test-api",
      });
      const auth = await createAuthService({
        users,
        sessions,
        tokens,
        passwordHasher: {
          hash: async (value) => `$test-hash$${value}`,
          verify: async (value, hash) => hash === `$test-hash$${value}`,
        },
      });
      const registered = await auth.register({
        email: `flow-${randomUUID()}@example.com`,
        password: "integration-only password",
      });
      const sessionLookup = await sessions.findByRefreshTokenHash(
        tokens.hashRefreshToken(registered.refreshToken),
      );
      expect(sessionLookup?.status).toBe("current");
      const sessionId = sessionLookup!.session.id;

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
      const tokens = createTokenService({
        secret: randomBytes(48).toString("base64url"),
        issuer: "integration-test",
        audience: "integration-test-api",
      });
      const auth = await createAuthService({
        users,
        sessions,
        tokens,
        passwordHasher: {
          hash: async (value) => `$test-hash$${value}`,
          verify: async (value, hash) => hash === `$test-hash$${value}`,
        },
      });
      const registered = await auth.register({
        email: `race-${randomUUID()}@example.com`,
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
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const userB = await users.create({
        email: `owner-b-${randomUUID()}@example.com`,
        passwordHash: "hash-b",
        emailVerified: false,
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

    it("revokes legacy sessions that lack replay history during repository setup", async () => {
      const user = await users.create({
        email: `legacy-${randomUUID()}@example.com`,
        passwordHash: "legacy-hash",
        emailVerified: false,
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
