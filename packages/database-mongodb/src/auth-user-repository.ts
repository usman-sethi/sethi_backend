import {
  DuplicateUserError,
  type AuthUserRecord,
  type AuthUserRepository,
  type CreateAuthUserInput,
} from "@sethi-backend/auth";
import {
  ObjectId,
  type Collection,
  type Db,
} from "mongodb";

interface AuthUserDocument {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MongoAuthUserRepositoryOptions {
  getDatabase: () => Db;
  collectionName?: string;
}

function toAuthUserRecord(document: AuthUserDocument): AuthUserRecord {
  return {
    id: document._id.toHexString(),
    email: document.email,
    passwordHash: document.passwordHash,
    emailVerified: document.emailVerified,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
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

export function createMongoAuthUserRepository(
  options: MongoAuthUserRepositoryOptions,
): AuthUserRepository {
  function collection(): Collection<AuthUserDocument> {
    return options.getDatabase().collection<AuthUserDocument>(
      options.collectionName ?? "auth_users",
    );
  }

  return {
    async ensureIndexes(): Promise<void> {
      await collection().createIndex(
        { email: 1 },
        { unique: true, name: "auth_users_email_unique" },
      );
    },

    async findByEmail(email: string): Promise<AuthUserRecord | null> {
      const document = await collection().findOne({ email });
      return document ? toAuthUserRecord(document) : null;
    },

    async findById(id: string): Promise<AuthUserRecord | null> {
      if (!ObjectId.isValid(id)) {
        return null;
      }

      const document = await collection().findOne({
        _id: new ObjectId(id),
      });

      return document ? toAuthUserRecord(document) : null;
    },

    async create(input: CreateAuthUserInput): Promise<AuthUserRecord> {
      const document: AuthUserDocument = {
        _id: new ObjectId(),
        email: input.email,
        passwordHash: input.passwordHash,
        emailVerified: input.emailVerified,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };

      try {
        await collection().insertOne(document);
        return toAuthUserRecord(document);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new DuplicateUserError({ cause: error });
        }

        throw error;
      }
    },
  };
}
