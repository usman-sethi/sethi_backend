import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ObjectId,
  type Db,
  type MongoClient,
} from "mongodb";

import {
  createMongoAuthActionTokenRepository,
} from "../src/auth-action-token-repository.js";

const mocks = vi.hoisted(() => ({
  createIndex: vi.fn(),
  updateOne: vi.fn(),
  updateMany: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  collection: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
}));

const tokenCollection = {
  createIndex: mocks.createIndex,
  updateOne: mocks.updateOne,
  findOne: mocks.findOne,
  findOneAndUpdate: mocks.findOneAndUpdate,
};
const userCollection = {
  updateOne: mocks.updateOne,
};
const sessionCollection = {
  updateMany: mocks.updateMany,
};
const database = {
  collection: mocks.collection,
} as unknown as Db;
const session = {
  withTransaction: mocks.withTransaction,
  endSession: mocks.endSession,
};
const client = {
  startSession: () => session,
} as unknown as MongoClient;

describe("MongoDB auth action-token repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.collection.mockImplementation((name: string) => {
      if (name === "auth_action_tokens") {
        return tokenCollection;
      }
      if (name === "auth_users") {
        return userCollection;
      }
      return sessionCollection;
    });
    mocks.createIndex.mockResolvedValue("index");
    mocks.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mocks.updateMany.mockResolvedValue({ modifiedCount: 1 });
    mocks.findOne.mockResolvedValue(null);
    mocks.findOneAndUpdate.mockResolvedValue(null);
    mocks.withTransaction.mockImplementation(async (operation: () => Promise<void>) =>
      operation()
    );
    mocks.endSession.mockResolvedValue(undefined);
  });

  function createRepository() {
    return createMongoAuthActionTokenRepository({
      getDatabase: () => database,
      getClient: () => client,
    });
  }

  it("creates unique hash and per-user-purpose indexes plus TTL cleanup", async () => {
    const repository = createRepository();
    await repository.ensureIndexes();

    expect(mocks.createIndex).toHaveBeenCalledWith(
      { tokenHash: 1 },
      { unique: true, name: "auth_action_tokens_hash_unique" },
    );
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { userId: 1, purpose: 1 },
      { unique: true, name: "auth_action_tokens_user_purpose_unique" },
    );
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "auth_action_tokens_expiry_ttl" },
    );
  });

  it("replaces a user's outstanding token without storing the raw value", async () => {
    const repository = createRepository();
    const userId = new ObjectId().toHexString();
    await repository.replaceForUser({
      userId,
      tokenHash: "sha256-token-hash",
      purpose: "email-verification",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      createdAt: new Date(),
    });

    expect(mocks.updateOne).toHaveBeenCalledWith(
      { userId: new ObjectId(userId), purpose: "email-verification" },
      expect.objectContaining({
        $set: expect.objectContaining({
          tokenHash: "sha256-token-hash",
          consumedAt: null,
        }),
      }),
      { upsert: true },
    );
    expect(JSON.stringify(mocks.updateOne.mock.calls)).not.toContain("raw-token");
  });

  it("consumes verification tokens and marks the user verified in one transaction", async () => {
    const repository = createRepository();
    const userId = new ObjectId();
    const token = {
      _id: new ObjectId(),
      userId,
      tokenHash: "hash",
      purpose: "email-verification",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      createdAt: new Date(),
    };
    mocks.findOneAndUpdate.mockResolvedValueOnce(token);

    await expect(repository.verifyEmail("hash", new Date())).resolves.toBe(true);

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.findOneAndUpdate.mock.calls[0]?.[0]).toMatchObject({
      tokenHash: "hash",
      purpose: "email-verification",
      consumedAt: null,
    });
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: userId, emailVerified: { $ne: true } },
      expect.objectContaining({
        $set: expect.objectContaining({
          emailVerified: true,
          emailVerifiedAt: expect.any(Date),
        }),
      }),
      { session },
    );
    expect(mocks.endSession).toHaveBeenCalledOnce();
  });

  it("updates password and revokes sessions in the token-consumption transaction", async () => {
    const repository = createRepository();
    const userId = new ObjectId();
    const token = {
      _id: new ObjectId(),
      userId,
      tokenHash: "reset-hash",
      purpose: "password-reset",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      createdAt: new Date(),
    };
    mocks.findOneAndUpdate.mockResolvedValueOnce(token);

    await expect(repository.resetPassword({
      tokenHash: "reset-hash",
      passwordHash: "argon2-hash",
      now: new Date(),
    })).resolves.toBe(true);

    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: userId },
      expect.objectContaining({
        $set: expect.objectContaining({ passwordHash: "argon2-hash" }),
      }),
      { session },
    );
    expect(mocks.updateMany).toHaveBeenCalledWith(
      { userId, revokedAt: null },
      expect.objectContaining({
        $set: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
      { session },
    );
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
  });
});
