import type {
  AuthActionTokenRecord,
  AuthActionTokenRepository,
  AuthActionTokenPurpose,
  ResetPasswordInput,
} from "@sethi-backend/auth";
import {
  ObjectId,
  type Collection,
  type Db,
  type MongoClient,
} from "mongodb";

interface AuthActionTokenDocument {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  purpose: AuthActionTokenPurpose;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface AuthUserDocument {
  _id: ObjectId;
  emailVerified: boolean;
  emailVerifiedAt?: Date | null;
  passwordHash: string;
  updatedAt: Date;
}

interface AuthSessionDocument {
  userId: ObjectId;
  revokedAt: Date | null;
  updatedAt: Date;
}

class TokenUserMissingError extends Error {}

export interface MongoAuthActionTokenRepositoryOptions {
  getDatabase: () => Db;
  getClient: () => MongoClient;
  tokenCollectionName?: string;
  userCollectionName?: string;
  sessionCollectionName?: string;
}

function toRecord(document: AuthActionTokenDocument): AuthActionTokenRecord {
  return {
    userId: document.userId.toHexString(),
    tokenHash: document.tokenHash,
    purpose: document.purpose,
    expiresAt: document.expiresAt,
    consumedAt: document.consumedAt,
    createdAt: document.createdAt,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}

export function createMongoAuthActionTokenRepository(
  options: MongoAuthActionTokenRepositoryOptions,
): AuthActionTokenRepository {
  function tokens(): Collection<AuthActionTokenDocument> {
    return options.getDatabase().collection<AuthActionTokenDocument>(
      options.tokenCollectionName ?? "auth_action_tokens",
    );
  }

  function users(): Collection<AuthUserDocument> {
    return options.getDatabase().collection<AuthUserDocument>(
      options.userCollectionName ?? "auth_users",
    );
  }

  function sessions(): Collection<AuthSessionDocument> {
    return options.getDatabase().collection<AuthSessionDocument>(
      options.sessionCollectionName ?? "auth_sessions",
    );
  }

  return {
    async ensureIndexes(): Promise<void> {
      await Promise.all([
        tokens().createIndex(
          { tokenHash: 1 },
          { unique: true, name: "auth_action_tokens_hash_unique" },
        ),
        tokens().createIndex(
          { userId: 1, purpose: 1 },
          { unique: true, name: "auth_action_tokens_user_purpose_unique" },
        ),
        tokens().createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "auth_action_tokens_expiry_ttl" },
        ),
      ]);
    },

    async replaceForUser(input): Promise<void> {
      const userId = new ObjectId(input.userId);
      const filter = { userId, purpose: input.purpose };
      const update = {
        $set: {
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          consumedAt: null,
          createdAt: input.createdAt,
        },
        $setOnInsert: { _id: new ObjectId() },
      };
      try {
        await tokens().updateOne(filter, update, { upsert: true });
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
        const retry = await tokens().updateOne(filter, update);
        if (retry.matchedCount !== 1) {
          throw error;
        }
      }
    },

    async findByHash(hash: string): Promise<AuthActionTokenRecord | null> {
      const document = await tokens().findOne({ tokenHash: hash });
      return document ? toRecord(document) : null;
    },

    async verifyEmail(tokenHash: string, now: Date): Promise<boolean> {
      const session = options.getClient().startSession();
      let verified = false;
      try {
        await session.withTransaction(async () => {
          verified = false;
          const token = await tokens().findOneAndUpdate(
            {
              tokenHash,
              purpose: "email-verification",
              consumedAt: null,
              expiresAt: { $gt: now },
            },
            { $set: { consumedAt: now } },
            { session, returnDocument: "after" },
          );
          if (!token) {
            return;
          }
          const result = await users().updateOne(
            { _id: token.userId, emailVerified: { $ne: true } },
            { $set: { emailVerified: true, emailVerifiedAt: now, updatedAt: now } },
            { session },
          );
          verified = result.modifiedCount === 1;
        });
      } finally {
        await session.endSession();
      }
      return verified;
    },

    async resetPassword(input: ResetPasswordInput): Promise<boolean> {
      const session = options.getClient().startSession();
      let completed = false;
      try {
        await session.withTransaction(async () => {
          completed = false;
          const token = await tokens().findOneAndUpdate(
            {
              tokenHash: input.tokenHash,
              purpose: "password-reset",
              consumedAt: null,
              expiresAt: { $gt: input.now },
            },
            { $set: { consumedAt: input.now } },
            { session, returnDocument: "after" },
          );
          if (!token) {
            return;
          }
          const updated = await users().updateOne(
            { _id: token.userId },
            { $set: { passwordHash: input.passwordHash, updatedAt: input.now } },
            { session },
          );
          if (updated.matchedCount !== 1) {
            throw new TokenUserMissingError("Password reset user no longer exists.");
          }
          await sessions().updateMany(
            { userId: token.userId, revokedAt: null },
            { $set: { revokedAt: input.now, updatedAt: input.now } },
            { session },
          );
          completed = true;
        });
      } catch (error) {
        if (error instanceof TokenUserMissingError) {
          return false;
        }
        throw error;
      } finally {
        await session.endSession();
      }
      return completed;
    },
  };
}
