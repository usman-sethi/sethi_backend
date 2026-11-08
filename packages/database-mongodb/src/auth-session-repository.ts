import type {
  AuthRefreshTokenLookup,
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionInput,
  RotateAuthSessionResult,
} from "@sethi-backend/auth";
import {
  ObjectId,
  type Collection,
  type Db,
} from "mongodb";

interface AuthSessionDocument {
  _id: ObjectId;
  userId: ObjectId;
  refreshTokenHash: string;
  consumedRefreshTokenHashes?: string[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  rotationCount?: number;
}

export const MAX_AUTH_SESSION_REFRESH_ROTATIONS = 100_000;

export interface MongoAuthSessionRepositoryOptions {
  getDatabase: () => Db;
  collectionName?: string;
}

function toObjectId(value: string, label: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new TypeError(`${label} must be a valid MongoDB ObjectId.`);
  }

  return new ObjectId(value);
}

function toAuthSessionRecord(
  document: AuthSessionDocument,
): AuthSessionRecord {
  return {
    id: document._id.toHexString(),
    userId: document.userId.toHexString(),
    refreshTokenHash: document.refreshTokenHash,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    expiresAt: document.expiresAt,
    revokedAt: document.revokedAt,
    rotationCount: document.rotationCount ?? 0,
  };
}

export function createMongoAuthSessionRepository(
  options: MongoAuthSessionRepositoryOptions,
): AuthSessionRepository {
  function collection(): Collection<AuthSessionDocument> {
    return options.getDatabase().collection<AuthSessionDocument>(
      options.collectionName ?? "auth_sessions",
    );
  }

  return {
    async ensureIndexes(): Promise<void> {
      await Promise.all([
        collection().createIndex(
          { refreshTokenHash: 1 },
          { unique: true, name: "auth_sessions_refresh_hash_unique" },
        ),
        collection().createIndex(
          { consumedRefreshTokenHashes: 1 },
          { name: "auth_sessions_consumed_hash" },
        ),
        collection().createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "auth_sessions_expiry_ttl" },
        ),
        collection().createIndex(
          { userId: 1, revokedAt: 1 },
          { name: "auth_sessions_user_active" },
        ),
      ]);

      const migratedAt = new Date();
      await collection().updateMany(
        {
          consumedRefreshTokenHashes: { $exists: false },
          revokedAt: null,
        },
        {
          $set: {
            consumedRefreshTokenHashes: [],
            rotationCount: 0,
            revokedAt: migratedAt,
            updatedAt: migratedAt,
          },
        },
      );
    },

    async create(input: CreateAuthSessionInput): Promise<AuthSessionRecord> {
      const document: AuthSessionDocument = {
        _id: new ObjectId(),
        userId: toObjectId(input.userId, "User ID"),
        refreshTokenHash: input.refreshTokenHash,
        consumedRefreshTokenHashes: [],
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        expiresAt: input.expiresAt,
        revokedAt: null,
        rotationCount: 0,
      };

      await collection().insertOne(document);
      return toAuthSessionRecord(document);
    },

    async findById(id: string): Promise<AuthSessionRecord | null> {
      if (!ObjectId.isValid(id)) {
        return null;
      }

      const document = await collection().findOne({
        _id: new ObjectId(id),
      });
      return document ? toAuthSessionRecord(document) : null;
    },

    async findByRefreshTokenHash(
      hash: string,
    ): Promise<AuthRefreshTokenLookup | null> {
      const current = await collection().findOne({
        refreshTokenHash: hash,
      });
      if (current) {
        return {
          session: toAuthSessionRecord(current),
          status: "current",
        };
      }

      const consumed = await collection().findOne({
        consumedRefreshTokenHashes: hash,
      });
      return consumed
        ? {
          session: toAuthSessionRecord(consumed),
          status: "consumed",
        }
        : null;
    },

    async rotateRefreshToken(input): Promise<RotateAuthSessionResult> {
      const id = toObjectId(input.id, "Session ID");
      const userId = toObjectId(input.userId, "User ID");
      const sessionCollection = collection();
      const document = await sessionCollection.findOneAndUpdate(
        {
          _id: id,
          userId,
          refreshTokenHash: input.currentRefreshTokenHash,
          revokedAt: null,
          expiresAt: { $gt: input.updatedAt },
          $or: [
            { rotationCount: { $lt: MAX_AUTH_SESSION_REFRESH_ROTATIONS } },
            { rotationCount: { $exists: false } },
          ],
        },
        {
          $set: {
            refreshTokenHash: input.newRefreshTokenHash,
            updatedAt: input.updatedAt,
          },
          $addToSet: {
            consumedRefreshTokenHashes: input.currentRefreshTokenHash,
          },
          $inc: {
            rotationCount: 1,
          },
        },
        { returnDocument: "after" },
      );

      if (document) {
        return {
          status: "rotated",
          session: toAuthSessionRecord(document),
        };
      }

      const replayedSession = await sessionCollection.findOneAndUpdate(
        {
          _id: id,
          userId,
          consumedRefreshTokenHashes: input.currentRefreshTokenHash,
          revokedAt: null,
          expiresAt: { $gt: input.updatedAt },
        },
        {
          $set: {
            revokedAt: input.updatedAt,
            updatedAt: input.updatedAt,
          },
        },
        { returnDocument: "after" },
      );

      if (replayedSession) {
        return {
          status: "replayed",
          session: toAuthSessionRecord(replayedSession),
        };
      }

      const exhaustedSession = await sessionCollection.findOneAndUpdate(
        {
          _id: id,
          userId,
          refreshTokenHash: input.currentRefreshTokenHash,
          revokedAt: null,
          expiresAt: { $gt: input.updatedAt },
          rotationCount: { $gte: MAX_AUTH_SESSION_REFRESH_ROTATIONS },
        },
        {
          $set: {
            revokedAt: input.updatedAt,
            updatedAt: input.updatedAt,
          },
        },
        { returnDocument: "after" },
      );
      return exhaustedSession
        ? {
          status: "rotation_limit",
          session: toAuthSessionRecord(exhaustedSession),
        }
        : { status: "invalid" };
    },

    async revokeById(
      id: string,
      userId: string,
      revokedAt: Date,
    ): Promise<boolean> {
      if (!ObjectId.isValid(id) || !ObjectId.isValid(userId)) {
        return false;
      }

      const result = await collection().updateOne(
        {
          _id: new ObjectId(id),
          userId: new ObjectId(userId),
          revokedAt: null,
        },
        { $set: { revokedAt, updatedAt: revokedAt } },
      );
      return result.modifiedCount === 1;
    },

    async revokeByRefreshTokenHash(
      hash: string,
      revokedAt: Date,
    ): Promise<boolean> {
      const result = await collection().updateOne(
        {
          $or: [
            { refreshTokenHash: hash },
            { consumedRefreshTokenHashes: hash },
          ],
          revokedAt: null,
        },
        { $set: { revokedAt, updatedAt: revokedAt } },
      );
      return result.modifiedCount === 1;
    },

    async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
      await collection().updateMany(
        {
          userId: toObjectId(userId, "User ID"),
          revokedAt: null,
        },
        { $set: { revokedAt, updatedAt: revokedAt } },
      );
    },
  };
}
