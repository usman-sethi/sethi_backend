import {
  DuplicateUserError,
  type AuthUserRecord,
  type AuthUserRepository,
  type CreateAuthUserInput,
  type PublicAuthUser,
  type UserRole,
  USER_ROLES,
} from "@sethi-backend/auth";
import {
  ObjectId,
  type Collection,
  type Db,
  type MongoClient,
} from "mongodb";

interface AuthUserDocument {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  emailVerified: boolean;
  emailVerifiedAt?: Date | null;
  role?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MongoAuthUserRepositoryOptions {
  getDatabase: () => Db;
  getClient?: () => MongoClient;
  collectionName?: string;
}

interface AuthAuditDocument {
  _id: ObjectId;
  type: "user.role_changed";
  actorUserId: string | null;
  targetUserId: string;
  previousRole: string;
  role: string;
  createdAt: Date;
}

interface AuthStateDocument {
  _id: string;
  version: number;
}

function isUserRole(value: string): value is UserRole {
  return USER_ROLES.some((role) => role === value);
}

function toAuthUserRecord(document: AuthUserDocument): AuthUserRecord {
  return {
    id: document._id.toHexString(),
    email: document.email,
    passwordHash: document.passwordHash,
    emailVerified: document.emailVerified === true,
    emailVerifiedAt: document.emailVerifiedAt ?? null,
    role: document.role && isUserRole(document.role)
      ? document.role
      : "user",
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

  function auditCollection(): Collection<AuthAuditDocument> {
    return options.getDatabase().collection<AuthAuditDocument>("auth_audit_logs");
  }

  function stateCollection(): Collection<AuthStateDocument> {
    return options.getDatabase().collection<AuthStateDocument>("auth_system_state");
  }

  return {
    async ensureIndexes(): Promise<void> {
      await Promise.all([
        collection().createIndex(
          { email: 1 },
          { unique: true, name: "auth_users_email_unique" },
        ),
        collection().createIndex(
          { role: 1 },
          { name: "auth_users_role" },
        ),
        auditCollection().createIndex(
          { targetUserId: 1, createdAt: -1 },
          { name: "auth_audit_target_created" },
        ),
        (async () => {
          try {
            await stateCollection().updateOne(
              { _id: "role-update-lock" },
              { $setOnInsert: { version: 0 } },
              { upsert: true },
            );
          } catch (error) {
            if (!isDuplicateKeyError(error)) {
              throw error;
            }
            const existing = await stateCollection().findOne({
              _id: "role-update-lock",
            });
            if (!existing) {
              throw error;
            }
          }
        })(),
      ]);

      const migratedAt = new Date();
      await collection().updateMany(
        { emailVerified: { $exists: false } },
        { $set: { emailVerified: false } },
      );
      await collection().updateMany(
        { emailVerifiedAt: { $exists: false } },
        { $set: { emailVerifiedAt: null } },
      );
      await collection().updateMany(
        { role: { $exists: false } },
        { $set: { role: "user", updatedAt: migratedAt } },
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

    async list(): Promise<PublicAuthUser[]> {
      const documents = await collection()
        .find({}, { projection: { passwordHash: 0 } })
        .sort({ createdAt: -1 })
        .toArray();
      return documents.map((document) => {
        const { passwordHash: _passwordHash, ...publicUser } =
          toAuthUserRecord(document);
        return publicUser;
      });
    },

    async setRole(userId, role, updatedAt, actorUserId) {
      if (!ObjectId.isValid(userId)) {
        return { status: "not_found" };
      }
      if (actorUserId === userId) {
        return { status: "actor_not_admin" };
      }
      const targetId = new ObjectId(userId);
      const mongoClient = options.getClient?.();
      if (!mongoClient) {
        throw new Error(
          "Role changes require a MongoDB client that supports transactions.",
        );
      }
      const session = mongoClient.startSession();
      let outcome:
        | { status: "updated"; user: AuthUserRecord; previousRole: AuthUserRecord["role"] }
        | {
          status:
            | "unchanged"
            | "not_found"
            | "last_admin"
            | "actor_not_admin"
            | "email_unverified";
        } =
          { status: "not_found" };
      try {
        await session.withTransaction(async () => {
          await stateCollection().updateOne(
            { _id: "role-update-lock" },
            { $inc: { version: 1 } },
            { session },
          );
          const users = collection();
          if (actorUserId) {
            const actor = await users.findOne(
              { _id: new ObjectId(actorUserId), role: "admin" },
              { session, projection: { _id: 1 } },
            );
            if (!actor) {
              outcome = { status: "actor_not_admin" };
              return;
            }
          }
          const current = await users.findOne({ _id: targetId }, { session });
          if (!current) {
            outcome = { status: "not_found" };
            return;
          }
          const currentUser = toAuthUserRecord(current);
          if (role === "admin" && !currentUser.emailVerified) {
            outcome = { status: "email_unverified" };
            return;
          }
          if (currentUser.role === role) {
            outcome = { status: "unchanged" };
            return;
          }
          if (currentUser.role === "admin" && role !== "admin") {
            const administrators = await users.countDocuments(
              { role: "admin" },
              { session },
            );
            if (administrators <= 1) {
              outcome = { status: "last_admin" };
              return;
            }
          }
          await users.updateOne(
            { _id: targetId },
            { $set: { role, updatedAt } },
            { session },
          );
          await auditCollection().insertOne(
            {
              _id: new ObjectId(),
              type: "user.role_changed",
              actorUserId,
              targetUserId: userId,
              previousRole: currentUser.role,
              role,
              createdAt: updatedAt,
            },
            { session },
          );
          const updated = await users.findOne({ _id: targetId }, { session });
          if (!updated) {
            throw new Error("Role update target disappeared within transaction.");
          }
          outcome = {
            status: "updated",
            user: toAuthUserRecord(updated),
            previousRole: currentUser.role,
          };
        });
      } finally {
        await session.endSession();
      }
      return outcome;
    },

    async create(input: CreateAuthUserInput): Promise<AuthUserRecord> {
      const document: AuthUserDocument = {
        _id: new ObjectId(),
        email: input.email,
        passwordHash: input.passwordHash,
        emailVerified: input.emailVerified,
        emailVerifiedAt: input.emailVerifiedAt,
        role: input.role,
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
