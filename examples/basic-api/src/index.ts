import { createBackend } from "@sethi-backend/core";

import {
  createAuthService,
  createAuthenticationGuard,
} from "@sethi-backend/auth";
import {
  createFastifyAdapter,
  createCsrfProtectionHook,
  generateCsrfToken,
  registerHttpSecurity,
} from "@sethi-backend/adapter-fastify";

import {
  createMongoDatabaseAdapter,
  createMongoAuthSessionRepository,
  createMongoAuthUserRepository,
} from "@sethi-backend/database-mongodb";
import { createPasswordHasher, createTokenService } from "@sethi-backend/security";

import { loadAppConfig } from "./config.js";
import { registerAuthRoutes } from "./auth-routes.js";

/**
 * Start the Sethi Backend application.
 */
async function main(): Promise<void> {
  // 1. Load and validate environment configuration.
  const config = loadAppConfig();

  // 2. Create the MongoDB adapter.
  const database = createMongoDatabaseAdapter({
    uri: config.mongodb.uri,
    databaseName: config.mongodb.databaseName,
  });
  const users = createMongoAuthUserRepository({
    getDatabase: () => database.getDatabase(),
  });
  const sessions = createMongoAuthSessionRepository({
    getDatabase: () => database.getDatabase(),
  });
  const tokens = createTokenService(config.tokens);
  const authService = await createAuthService({
    users,
    sessions,
    passwordHasher: createPasswordHasher(),
    tokens,
  });
  const authGuard = createAuthenticationGuard({ users, sessions, tokens });

  // 3. Create the Fastify adapter.
  const http = createFastifyAdapter({
    logger: config.environment !== "test",
  });

  registerHttpSecurity(http.instance, {
    allowedOrigins: config.httpSecurity.corsOrigins,
    environment: config.environment,
  });

  http.instance.addHook("onReady", async () => {
    await Promise.all([
      users.ensureIndexes(),
      sessions.ensureIndexes(),
    ]);
  });

  registerAuthRoutes(http.instance, {
    service: authService,
    guard: authGuard,
    environment: config.environment,
    csrfProtection: createCsrfProtectionHook(http.instance),
  });

  // 4. Register a CSRF token endpoint for cookie-authenticated clients.
  http.instance.get("/csrf-token", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");

    return {
      token: generateCsrfToken(reply),
    };
  });

  // 5. Register the health endpoint.
  http.instance.get("/health", async () => {
    return {
      status: "ok",
      service: "sethi-backend",
      uptimeSeconds: Math.floor(process.uptime()),
    };
  });

  // 6. Register the database readiness endpoint.
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

  // 7. Compose the application.
  const app = createBackend({
    server: config.server,
    adapter: http,
    database,
  });

  let shuttingDown = false;

  /**
   * Graceful shutdown handler.
   */
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

  const handleSigint = (): void => {
    void shutdown("SIGINT");
  };

  const handleSigterm = (): void => {
    void shutdown("SIGTERM");
  };

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  // 8. Start the application.
  try {
    await app.start();

    console.log(
      `Sethi Backend listening at http://${config.server.host}:${config.server.port}`,
    );
  } catch (error) {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);

    throw error;
  }
}

/**
 * Handle configuration and startup failures.
 */
await main().catch((error: unknown) => {
  console.error("Failed to start Sethi Backend.");

  console.error(
    error instanceof Error ? error.message : error,
  );

  process.exitCode = 1;
});