import { createBackend } from "@sethi-backend/core";

import {
  createFastifyAdapter,
} from "@sethi-backend/adapter-fastify";

import {
  createMongoDatabaseAdapter,
} from "@sethi-backend/database-mongodb";

/**
 * Read and validate required environment configuration.
 */
function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}`,
    );
  }

  return value;
}

/**
 * Read and validate the server port.
 */
function readPort(): number {
  const value = Number(process.env.PORT ?? 3000);

  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new Error(
      "PORT must be an integer between 1 and 65535.",
    );
  }

  return value;
}

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = readPort();

const mongoUri = requiredEnv("MONGODB_URI");
const databaseName = requiredEnv("MONGODB_DATABASE");

/**
 * Create infrastructure adapters.
 */
const database = createMongoDatabaseAdapter({
  uri: mongoUri,
  databaseName,
});

const http = createFastifyAdapter({
  logger: true,
});

/**
 * Liveness endpoint.
 *
 * This checks whether the HTTP application is responding.
 */
http.instance.get("/health", async () => {
  return {
    status: "ok",
    service: "sethi-backend",
    uptimeSeconds: Math.floor(process.uptime()),
  };
});

/**
 * Readiness endpoint.
 *
 * This checks whether MongoDB can respond to a ping.
 */
http.instance.get("/ready", async (_request, reply) => {
  try {
    await database.getDatabase().command({
      ping: 1,
    });

    return reply.code(200).send({
      status: "ready",
      database: "reachable",
    });
  } catch {
    return reply.code(503).send({
      status: "not_ready",
      database: "unavailable",
    });
  }
});

/**
 * Compose the application.
 */
const app = createBackend({
  server: {
    host,
    port,
  },

  adapter: http,
  database,
});

/**
 * Graceful shutdown.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`Received ${signal}. Shutting down...`);

  try {
    await app.stop();

    console.log("Sethi Backend stopped successfully.");
  } catch (error) {
    console.error("Shutdown failed:", error);

    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

/**
 * Start the application.
 */
try {
  await app.start();

  console.log(
    `Sethi Backend listening at http://${host}:${port}`,
  );
} catch (error) {
  console.error("Failed to start Sethi Backend:", error);

  process.exitCode = 1;
}