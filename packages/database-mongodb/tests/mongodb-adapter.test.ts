import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  db: vi.fn(),
  fakeDatabase: {
    name: "test_database",
  },
}));

vi.mock("mongodb", () => ({
  MongoClient: class {
    connect = mocks.connect;
    close = mocks.close;
    db = mocks.db;
  },
}));

import {
  createMongoDatabaseAdapter,
} from "../src/index.js";

describe("MongoDB Adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.connect.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.db.mockReturnValue(mocks.fakeDatabase);
  });

  it("should connect to MongoDB", async () => {
    const adapter = createMongoDatabaseAdapter({
      uri: "mongodb://localhost:27017",
      databaseName: "test_database",
    });

    expect(adapter.isConnected()).toBe(false);

    await adapter.connect();

    expect(mocks.connect).toHaveBeenCalledOnce();

    expect(mocks.db).toHaveBeenCalledWith(
      "test_database",
    );

    expect(adapter.isConnected()).toBe(true);

    expect(adapter.getDatabase()).toBe(
      mocks.fakeDatabase,
    );
  });

  it("should reject database access before connecting", () => {
    const adapter = createMongoDatabaseAdapter({
      uri: "mongodb://localhost:27017",
      databaseName: "test_database",
    });

    expect(() => adapter.getDatabase()).toThrow(
      "MongoDB is not connected. Call connect() first.",
    );
  });

  it("should not create multiple connections when already connected", async () => {
    const adapter = createMongoDatabaseAdapter({
      uri: "mongodb://localhost:27017",
      databaseName: "test_database",
    });

    await adapter.connect();
    await adapter.connect();

    expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it("should disconnect from MongoDB", async () => {
    const adapter = createMongoDatabaseAdapter({
      uri: "mongodb://localhost:27017",
      databaseName: "test_database",
    });

    await adapter.connect();
    await adapter.disconnect();

    expect(mocks.close).toHaveBeenCalledOnce();

    expect(adapter.isConnected()).toBe(false);

    expect(() => adapter.getDatabase()).toThrow(
      "MongoDB is not connected. Call connect() first.",
    );
  });

  it("should clean up after a failed connection", async () => {
    const connectionError = new Error(
      "MongoDB connection failed",
    );

    mocks.connect.mockRejectedValueOnce(
      connectionError,
    );

    const adapter = createMongoDatabaseAdapter({
      uri: "mongodb://localhost:27017",
      databaseName: "test_database",
    });

    await expect(
      adapter.connect(),
    ).rejects.toThrow("MongoDB connection failed");

    expect(mocks.close).toHaveBeenCalledOnce();

    expect(adapter.isConnected()).toBe(false);

    // A fresh connection attempt should be possible.
    await adapter.connect();

    expect(adapter.isConnected()).toBe(true);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });
});