export {
  createMongoAuthUserRepository,
} from "./auth-user-repository.js";
export type {
  MongoAuthUserRepositoryOptions,
} from "./auth-user-repository.js";

export {
  createMongoAuthSessionRepository,
} from "./auth-session-repository.js";
export type {
  MongoAuthSessionRepositoryOptions,
} from "./auth-session-repository.js";

import {
  MongoClient,
  type Db,
  type MongoClientOptions,
} from "mongodb";

import type {
  DatabaseAdapter,
} from "@sethi-backend/core";

/**
 * Configuration for the MongoDB adapter.
 */
export interface MongoDatabaseAdapterOptions {
  uri: string;
  databaseName: string;
  clientOptions?: MongoClientOptions;
}

/**
 * Public MongoDB adapter API.
 */
export interface MongoDatabaseAdapter
  extends DatabaseAdapter {
  getDatabase(): Db;
  isConnected(): boolean;
}

type MongoAdapterState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "disconnected";

/**
 * Creates a MongoDB database adapter.
 */
export function createMongoDatabaseAdapter(
  options: MongoDatabaseAdapterOptions,
): MongoDatabaseAdapter {
  const uri = options.uri.trim();
  const databaseName = options.databaseName.trim();

  if (!uri) {
    throw new Error("MongoDB connection URI is required.");
  }

  if (!databaseName) {
    throw new Error("MongoDB database name is required.");
  }

  let client: MongoClient | undefined;
  let database: Db | undefined;

  let state: MongoAdapterState = "idle";

  /**
   * Connects to MongoDB.
   */
  async function connect(): Promise<void> {
    if (state === "connected") {
      return;
    }

    if (
      state === "connecting" ||
      state === "disconnecting"
    ) {
      throw new Error(
        `Cannot connect to MongoDB while state is "${state}".`,
      );
    }

    const nextClient = options.clientOptions
      ? new MongoClient(uri, options.clientOptions)
      : new MongoClient(uri);

    state = "connecting";

    try {
      await nextClient.connect();

      client = nextClient;
      database = nextClient.db(databaseName);

      state = "connected";
    } catch (error) {
      try {
        await nextClient.close();
      } catch (cleanupError) {
        state = "idle";

        throw new AggregateError(
          [error, cleanupError],
          "MongoDB connection failed and client cleanup was unsuccessful.",
        );
      }

      state = "idle";

      throw error;
    }
  }

  /**
   * Gracefully disconnects from MongoDB.
   */
  async function disconnect(): Promise<void> {
    if (
      state === "connecting" ||
      state === "disconnecting"
    ) {
      throw new Error(
        `Cannot disconnect from MongoDB while state is "${state}".`,
      );
    }

    const currentClient = client;

    if (!currentClient) {
      database = undefined;
      state = "disconnected";
      return;
    }

    state = "disconnecting";

    try {
      await currentClient.close();
    } finally {
      client = undefined;
      database = undefined;

      state = "disconnected";
    }
  }

  /**
   * Returns the active database instance.
   */
  function getDatabase(): Db {
    if (!database || state !== "connected") {
      throw new Error(
        "MongoDB is not connected. Call connect() first.",
      );
    }

    return database;
  }

  return {
    connect,
    disconnect,
    getDatabase,

    isConnected(): boolean {
      return state === "connected";
    },
  };
}