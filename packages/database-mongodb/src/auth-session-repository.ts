import type {
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionInput,
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
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

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
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "auth_sessions_expiry_ttl" },
        ),
        collection().createIndex(
          { userId: 1, revokedAt: 1 },
          { name: "auth_sessions_user_active" },
        ),
      ]);
    },

    async create(input: CreateAuthSessionInput): Promise<AuthSessionRecord> {
      const document: AuthSessionDocument = {
        _id: new ObjectId(),
        userId: toObjectId(input.userId, "User ID"),
        refreshTokenHash: input.refreshTokenHash,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        expiresAt: input.expiresAt,
        revokedAt: null,
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
    ): Promise<AuthSessionRecord | null> {
      const document = await collection().findOne({
        refreshTokenHash: hash,
      });
      return document ? toAuthSessionRecord(document) : null;
    },

    async rotateRefreshToken(input): Promise<AuthSessionRecord | null> {
      const id = toObjectId(input.id, "Session ID");
      const userId = toObjectId(input.userId, "User ID");
      const document = await collection().findOneAndUpdate(
        {
          _id: id,
          userId,
          refreshTokenHash: input.currentRefreshTokenHash,
          revokedAt: null,
          expiresAt: { $gt: input.updatedAt },
        },
        {
          $set: {
            refreshTokenHash: input.newRefreshTokenHash,
            updatedAt: input.updatedAt,
          },
        },
        { returnDocument: "after" },
      );

      return document ? toAuthSessionRecord(document) : null;
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
        { refreshTokenHash: hash, revokedAt: null },
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
