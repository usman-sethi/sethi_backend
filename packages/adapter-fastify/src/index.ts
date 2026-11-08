import Fastify, {
  type FastifyInstance,
} from "fastify";

import type {
  HttpServerAdapter,
  ServerOptions,
} from "@sethi-backend/core";

/**
 * Configuration for the Fastify adapter.
 */
export interface FastifyAdapterOptions {
  logger?: boolean;
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
  const instance = Fastify({
    logger: options.logger ?? false,
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

      if (state === "running") {
        await instance.close();
      }

      state = "stopped";
    },
  };
}

export {
  createCsrfProtectionHook,
  generateCsrfToken,
  getHttpCookieOptions,
  normalizeAllowedOrigins,
  registerHttpSecurity,
} from "./http-security.js";

export type {
  HttpSecurityEnvironment,
  HttpSecurityOptions,
} from "./http-security.js";