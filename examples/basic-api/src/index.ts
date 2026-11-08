import { createBackend } from "@sethi-backend/core";

import {
  createAuthService,
  createAuthenticationGuard,
  type AuthSecurityEvent,
} from "@sethi-backend/auth";
import {
  ConfigValidationError,
} from "@sethi-backend/config";
import {
  createFastifyAdapter,
  createCsrfProtectionHook,
  generateCsrfToken,
  registerHttpSecurity,
} from "@sethi-backend/adapter-fastify";

import {
  createMongoDatabaseAdapter,
  createMongoAuthActionTokenRepository,
  createMongoAuthSessionRepository,
  createMongoAuthUserRepository,
} from "@sethi-backend/database-mongodb";
import { createSmtpEmailSender } from "@sethi-backend/email";
import { createPasswordHasher, createTokenService } from "@sethi-backend/security";

import { loadAppConfig } from "./config.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerHealthRoutes } from "./health-routes.js";

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
    getClient: () => database.getClient(),
  });
  const sessions = createMongoAuthSessionRepository({
    getDatabase: () => database.getDatabase(),
  });
  const actionTokens = createMongoAuthActionTokenRepository({
    getDatabase: () => database.getDatabase(),
    getClient: () => database.getClient(),
  });
  const tokens = createTokenService(config.tokens);
  const emailSender = config.email.smtp
    ? createSmtpEmailSender(config.email.smtp)
    : undefined;

  // 3. Create and secure the Fastify adapter before wiring sanitized auth logs.
  const http = createFastifyAdapter({
    logger: config.environment !== "test",
  });

  registerHttpSecurity(http.instance, {
    allowedOrigins: config.httpSecurity.corsOrigins,
    environment: config.environment,
  });

  const securityEventLogger = (event: AuthSecurityEvent): void => {
    const { type, ...metadata } = event;
    http.instance.log.info(
      { event: `auth.${type}`, ...metadata },
      "Authentication security event",
    );
  };
  const authService = await createAuthService({
    users,
    sessions,
    actionTokens,
    passwordHasher: createPasswordHasher(),
    tokens,
    ...(emailSender ? { emailSender } : {}),
    ...(config.email.appBaseUrl
      ? { appBaseUrl: config.email.appBaseUrl }
      : {}),
    emailVerificationTokenTtlSeconds:
      config.email.emailVerificationTokenTtlSeconds,
    passwordResetTokenTtlSeconds:
      config.email.passwordResetTokenTtlSeconds,
    securityEventLogger,
  });
  const authGuard = createAuthenticationGuard({
    users,
    sessions,
    tokens,
    securityEventLogger,
  });

  http.instance.addHook("onReady", async () => {
    await Promise.all([
      users.ensureIndexes(),
      sessions.ensureIndexes(),
      actionTokens.ensureIndexes(),
    ]);
  });

  registerAuthRoutes(http.instance, {
    service: authService,
    guard: authGuard,
    environment: config.environment,
    csrfProtection: createCsrfProtectionHook(http.instance),
  });
  registerAdminRoutes(http.instance, {
    guard: authGuard,
    users,
    service: authService,
  });

  // 4. Register a CSRF token endpoint for cookie-authenticated clients.
  http.instance.get("/csrf-token", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");

    return {
      token: generateCsrfToken(reply),
    };
  });

  registerHealthRoutes(http.instance, async () => {
    await database.getDatabase().command({ ping: 1 });
  });

  // 6. Compose the application.
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

    http.instance.log.info({
      event: "app.shutdown_started",
      signal,
    }, "Application shutdown started");

    try {
      await app.stop();

      http.instance.log.info({
        event: "app.shutdown_completed",
        signal,
      }, "Application shutdown completed");
    } catch (error) {
      http.instance.log.error({
        event: "app.shutdown_failed",
        signal,
        errorName: safeErrorName(error),
      }, "Application shutdown failed");

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

  // 7. Start the application.
  try {
    await app.start();

    http.instance.log.info({
      event: "app.started",
      host: config.server.host,
      port: config.server.port,
      environment: config.environment,
    }, "Sethi Backend is listening");
  } catch (error) {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);

    throw error;
  }
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error";
}

/**
 * Handle configuration and startup failures.
 */
await main().catch((error: unknown) => {
  const details = error instanceof ConfigValidationError
    ? error.message
    : undefined;
  console.error("Failed to start Sethi Backend.", {
    event: "app.startup_failed",
    errorName: safeErrorName(error),
    ...(details ? { details } : {}),
  });

  process.exitCode = 1;
});