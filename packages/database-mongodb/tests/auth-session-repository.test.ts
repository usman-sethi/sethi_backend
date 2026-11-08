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
} from "mongodb";

import {
  createMongoAuthSessionRepository,
} from "../src/auth-session-repository.js";

const mocks = vi.hoisted(() => ({
  createIndex: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
  updateMany: vi.fn(),
  collection: vi.fn(),
}));

describe("MongoDB auth session repository", () => {
  const collection = {
    createIndex: mocks.createIndex,
    findOne: mocks.findOne,
    findOneAndUpdate: mocks.findOneAndUpdate,
    insertOne: mocks.insertOne,
    updateOne: mocks.updateOne,
    updateMany: mocks.updateMany,
  };
  const database = {
    collection: mocks.collection,
  } as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.collection.mockReturnValue(collection);
    mocks.createIndex.mockResolvedValue("index");
    mocks.findOne.mockResolvedValue(null);
    mocks.findOneAndUpdate.mockResolvedValue(null);
    mocks.insertOne.mockResolvedValue(undefined);
    mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.updateMany.mockResolvedValue({ modifiedCount: 1 });
  });

  function createRepository() {
    return createMongoAuthSessionRepository({
      getDatabase: () => database,
    });
  }

  it("creates unique refresh-hash and expiry indexes", async () => {
    const repository = createRepository();

    await repository.ensureIndexes();

    expect(mocks.collection).toHaveBeenCalledWith("auth_sessions");
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { refreshTokenHash: 1 },
      { unique: true, name: "auth_sessions_refresh_hash_unique" },
    );
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "auth_sessions_expiry_ttl" },
    );
  });

  it("persists only the refresh-token hash and maps session IDs", async () => {
    const repository = createRepository();
    const userId = new ObjectId().toHexString();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);

    const session = await repository.create({
      userId,
      refreshTokenHash: "sha256-hash",
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });

    const storedDocument = mocks.insertOne.mock.calls[0]?.[0];
    expect(storedDocument).toMatchObject({
      userId: new ObjectId(userId),
      refreshTokenHash: "sha256-hash",
      revokedAt: null,
    });
    expect(session.id).toMatch(/^[a-f0-9]{24}$/);
    expect(session.userId).toBe(userId);
  });

  it("rotates only when the stored hash and active session match", async () => {
    const repository = createRepository();
    const id = new ObjectId();
    const userId = new ObjectId();
    const updatedAt = new Date();
    const result = await repository.rotateRefreshToken({
      id: id.toHexString(),
      userId: userId.toHexString(),
      currentRefreshTokenHash: "old-hash",
      newRefreshTokenHash: "new-hash",
      updatedAt,
    });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: id,
        userId,
        refreshTokenHash: "old-hash",
        revokedAt: null,
        expiresAt: { $gt: updatedAt },
      },
      {
        $set: {
          refreshTokenHash: "new-hash",
          updatedAt,
        },
      },
      { returnDocument: "after" },
    );
    expect(result).toBeNull();
  });

  it("revokes all active sessions for the requested user", async () => {
    const repository = createRepository();
    const userId = new ObjectId();
    const revokedAt = new Date();

    await repository.revokeAllForUser(userId.toHexString(), revokedAt);

    expect(mocks.updateMany).toHaveBeenCalledWith(
      { userId, revokedAt: null },
      { $set: { revokedAt, updatedAt: revokedAt } },
    );
  });
});
