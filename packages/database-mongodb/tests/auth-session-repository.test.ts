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
  MAX_AUTH_SESSION_REFRESH_ROTATIONS,
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
      { consumedRefreshTokenHashes: 1 },
      { name: "auth_sessions_consumed_hash" },
    );
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "auth_sessions_expiry_ttl" },
    );
    expect(mocks.updateMany).toHaveBeenCalledWith(
      {
        consumedRefreshTokenHashes: { $exists: false },
        revokedAt: null,
      },
      {
        $set: expect.objectContaining({
          consumedRefreshTokenHashes: [],
          rotationCount: 0,
          revokedAt: expect.any(Date),
          updatedAt: expect.any(Date),
        }),
      },
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
      consumedRefreshTokenHashes: [],
      revokedAt: null,
      rotationCount: 0,
    });
    expect(JSON.stringify(storedDocument)).not.toContain("raw-refresh-token");
    expect(session.id).toMatch(/^[a-f0-9]{24}$/);
    expect(session.userId).toBe(userId);
  });

  it("atomically consumes the previous hash while setting the next hash", async () => {
    const repository = createRepository();
    const id = new ObjectId();
    const userId = new ObjectId();
    const updatedAt = new Date();
    const updatedDocument = {
      _id: id,
      userId,
      refreshTokenHash: "new-hash",
      consumedRefreshTokenHashes: ["old-hash"],
      createdAt: updatedAt,
      updatedAt,
      expiresAt: new Date(updatedAt.getTime() + 60_000),
      revokedAt: null,
      rotationCount: 1,
    };
    mocks.findOneAndUpdate.mockResolvedValueOnce(updatedDocument);
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
        $or: [
          { rotationCount: { $lt: MAX_AUTH_SESSION_REFRESH_ROTATIONS } },
          { rotationCount: { $exists: false } },
        ],
      },
      {
        $set: {
          refreshTokenHash: "new-hash",
          updatedAt,
        },
        $addToSet: {
          consumedRefreshTokenHashes: "old-hash",
        },
        $inc: {
          rotationCount: 1,
        },
      },
      { returnDocument: "after" },
    );
    expect(result).toMatchObject({
      status: "rotated",
      session: {
        id: id.toHexString(),
        userId: userId.toHexString(),
        refreshTokenHash: "new-hash",
      },
    });
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("revokes a live session when a consumed refresh hash is replayed", async () => {
    const repository = createRepository();
    const id = new ObjectId();
    const userId = new ObjectId();
    const now = new Date();
    const revokedDocument = {
      _id: id,
      userId,
      refreshTokenHash: "current-hash",
      consumedRefreshTokenHashes: ["replayed-hash"],
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: now,
    };
    mocks.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(revokedDocument);

    const result = await repository.rotateRefreshToken({
      id: id.toHexString(),
      userId: userId.toHexString(),
      currentRefreshTokenHash: "replayed-hash",
      newRefreshTokenHash: "unissued-hash",
      updatedAt: now,
    });

    expect(mocks.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        _id: id,
        userId,
        consumedRefreshTokenHashes: "replayed-hash",
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          revokedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    expect(result).toMatchObject({
      status: "replayed",
      session: { revokedAt: now },
    });
  });

  it("locates consumed hashes separately from the active refresh hash", async () => {
    const repository = createRepository();
    const now = new Date();
    mocks.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: new ObjectId(),
        userId: new ObjectId(),
        refreshTokenHash: "current-hash",
        consumedRefreshTokenHashes: ["old-hash"],
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: null,
      });

    const lookup = await repository.findByRefreshTokenHash("old-hash");

    expect(mocks.findOne).toHaveBeenNthCalledWith(
      1,
      { refreshTokenHash: "old-hash" },
    );
    expect(mocks.findOne).toHaveBeenNthCalledWith(
      2,
      { consumedRefreshTokenHashes: "old-hash" },
    );
    expect(lookup?.status).toBe("consumed");
  });

  it("revokes a session rather than growing history beyond the retention cap", async () => {
    const repository = createRepository();
    const id = new ObjectId();
    const userId = new ObjectId();
    const now = new Date();
    const expiredByPolicyDocument = {
      _id: id,
      userId,
      refreshTokenHash: "current-hash",
      consumedRefreshTokenHashes: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: now,
      rotationCount: MAX_AUTH_SESSION_REFRESH_ROTATIONS,
    };
    mocks.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(expiredByPolicyDocument);

    const result = await repository.rotateRefreshToken({
      id: id.toHexString(),
      userId: userId.toHexString(),
      currentRefreshTokenHash: "current-hash",
      newRefreshTokenHash: "next-hash",
      updatedAt: now,
    });

    expect(mocks.findOneAndUpdate).toHaveBeenNthCalledWith(
      3,
      {
        _id: id,
        userId,
        refreshTokenHash: "current-hash",
        revokedAt: null,
        expiresAt: { $gt: now },
        rotationCount: { $gte: MAX_AUTH_SESSION_REFRESH_ROTATIONS },
      },
      {
        $set: {
          revokedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    expect(result.status).toBe("rotation_limit");
  });

  it("conditions individual revocation on both session and owner IDs", async () => {
    const repository = createRepository();
    const id = new ObjectId();
    const userId = new ObjectId();
    const revokedAt = new Date();

    await repository.revokeById(
      id.toHexString(),
      userId.toHexString(),
      revokedAt,
    );

    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: id, userId, revokedAt: null },
      { $set: { revokedAt, updatedAt: revokedAt } },
    );
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
