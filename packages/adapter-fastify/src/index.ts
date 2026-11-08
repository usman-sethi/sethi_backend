import Fastify, {
  LogController,
  type FastifyLoggerOptions,
  type FastifyInstance,
} from "fastify";
import { randomUUID } from "node:crypto";

import type {
  HttpServerAdapter,
  ServerOptions,
} from "@sethi-backend/core";

/**
 * Configuration for the Fastify adapter.
 */
export interface FastifyAdapterOptions {
  logger?: boolean | (FastifyLoggerOptions & {
    redact?: {
      paths?: readonly string[];
      censor?: string;
    };
  });
}

/**
 * Public Fastify adapter contract.
 *
 * Extends the core HTTP adapter and exposes the
 * Fastify instance so applications can register routes.
 */
export interface FastifyHttpAdapter
  extends HttpServerAdapter {
  readonly instance: FastifyInstance;
}

/**
 * Creates a Fastify HTTP adapter.
 */
export function createFastifyAdapter(
  options: FastifyAdapterOptions = {},
): FastifyHttpAdapter {
  const redactPaths = [
    "req.headers.authorization",
    "req.headers.cookie",
    'res.headers["set-cookie"]',
    "password",
    "passwordHash",
    "token",
    "accessToken",
    "refreshToken",
    "SMTP_PASSWORD",
  ];
  const logger = options.logger === true
    ? {
      redact: { paths: redactPaths, censor: "[REDACTED]" },
    }
    : typeof options.logger === "object"
    ? {
      ...options.logger,
      redact: {
        paths: [...redactPaths, ...(options.logger.redact?.paths ?? [])],
        censor: "[REDACTED]",
      },
    }
    : false;

  const instance = Fastify({
    logger,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
  });

  instance.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });

  instance.addHook("onResponse", async (request, reply) => {
    request.log.info({
      event: "http.request.completed",
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? "<unmatched>",
      statusCode: reply.statusCode,
      responseTimeMs: reply.elapsedTime,
    }, "HTTP request completed");
  });

  instance.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Not found.",
        requestId: request.id,
      },
    });
  });

  instance.setErrorHandler((error, request, reply) => {
    const candidateStatusCode = typeof error === "object" &&
        error !== null && "statusCode" in error
      ? error.statusCode
      : undefined;
    const statusCode = typeof candidateStatusCode === "number" &&
      Number.isInteger(candidateStatusCode) &&
      candidateStatusCode >= 400 && candidateStatusCode < 600
      ? candidateStatusCode
      : 500;
    const messages: Readonly<Record<number, string>> = {
      400: "Invalid request.",
      401: "Unauthorized.",
      403: "Forbidden.",
      404: "Not found.",
      405: "Method not allowed.",
      408: "Request timed out.",
      413: "Payload too large.",
      415: "Unsupported media type.",
      429: "Too many requests.",
    };
    const rawErrorName = error instanceof Error ? error.name : "UnknownError";
    const errorName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(rawErrorName)
      ? rawErrorName
      : "Error";

    if (statusCode >= 500) {
      request.log.error({
        event: "http.request.failed",
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? "<unmatched>",
        statusCode,
        errorName,
      }, "HTTP request failed");
    }

    return reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message: messages[statusCode] ??
          (statusCode >= 500 ? "Internal server error." : "Request failed."),
        requestId: request.id,
      },
    });
  });

  type AdapterState =
    | "idle"
    | "starting"
    | "running"
    | "stopped";

  let state: AdapterState = "idle";

  return {
    instance,

    /**
     * Starts the Fastify HTTP server.
     */
    async start(serverOptions: ServerOptions): Promise<void> {
      if (state !== "idle") {
        throw new Error(
          `Cannot start Fastify adapter while state is "${state}".`,
        );
      }

      state = "starting";

      try {
        await instance.listen({
          host: serverOptions.host,
          port: serverOptions.port,
        });

        state = "running";
      } catch (error) {
        state = "idle";
        throw error;
      }
    },

    /**
     * Gracefully shuts down the Fastify server.
     */
    async stop(): Promise<void> {
      if (state === "stopped") {
        return;
      }

      if (state === "starting") {
        throw new Error(
          "Cannot stop Fastify adapter while it is starting.",
        );
      }

      if (state === "idle") {
        return;
      }

      await instance.close();
      state = "stopped";
    },
  };
}

export {
  createCsrfProtectionHook,
  createRedisRateLimitClient,
  generateCsrfToken,
  getHttpCookieOptions,
  normalizeAllowedOrigins,
  registerHttpSecurity,
} from "./http-security.js";

export type {
  HttpSecurityEnvironment,
  HttpSecurityOptions,
  RedisRateLimitClientOptions,
} from "./http-security.js";