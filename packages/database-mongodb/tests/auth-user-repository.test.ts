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
  createMongoAuthUserRepository,
} from "../src/auth-user-repository.js";

const mocks = vi.hoisted(() => ({
  createIndex: vi.fn(),
  findOne: vi.fn(),
  insertOne: vi.fn(),
  collection: vi.fn(),
}));

describe("MongoDB auth user repository", () => {
  const collection = {
    createIndex: mocks.createIndex,
    findOne: mocks.findOne,
    insertOne: mocks.insertOne,
  };
  const database = {
    collection: mocks.collection,
  } as unknown as Db;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.collection.mockReturnValue(collection);
    mocks.createIndex.mockResolvedValue("auth_users_email_unique");
    mocks.findOne.mockResolvedValue(null);
  });

  function createRepository() {
    return createMongoAuthUserRepository({
      getDatabase: () => database,
    });
  }

  it("creates a unique index on normalized email", async () => {
    const repository = createRepository();

    await repository.ensureIndexes();

    expect(mocks.collection).toHaveBeenCalledWith("auth_users");
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { email: 1 },
      { unique: true, name: "auth_users_email_unique" },
    );
  });

  it("maps MongoDB user documents to records and rejects invalid IDs safely", async () => {
    const id = new ObjectId();
    mocks.findOne.mockResolvedValue({
      _id: id,
      email: "user@example.com",
      passwordHash: "argon-hash",
      emailVerified: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const repository = createRepository();

    await expect(repository.findByEmail("user@example.com")).resolves.toMatchObject({
      id: id.toHexString(),
      email: "user@example.com",
      passwordHash: "argon-hash",
    });
    expect(await repository.findById("not-an-object-id")).toBeNull();
    expect(mocks.findOne).toHaveBeenCalledTimes(1);
  });

  it("persists a user without returning MongoDB internal fields", async () => {
    mocks.insertOne.mockResolvedValue(undefined);
    const repository = createRepository();
    const createdAt = new Date();

    const user = await repository.create({
      email: "user@example.com",
      passwordHash: "argon-hash",
      emailVerified: false,
      createdAt,
      updatedAt: createdAt,
    });

    expect(mocks.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        passwordHash: "argon-hash",
      }),
    );
    expect(user).not.toHaveProperty("_id");
    expect(user.id).toMatch(/^[a-f0-9]{24}$/);
  });

  it("maps duplicate-key races to a public duplicate-user error", async () => {
    mocks.insertOne.mockRejectedValue({ code: 11000 });
    const repository = createRepository();

    await expect(
      repository.create({
        email: "user@example.com",
        passwordHash: "argon-hash",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow("A user with this email already exists.");
  });
});
