
import type { FastifyInstance } from "fastify";

import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";

export interface HttpSecurityOptions {
  allowedOrigins: string[];
}

/**
 * Register common HTTP security plugins.
 *
 * Call before registering application routes.
 */
export function registerHttpSecurity(
  server: FastifyInstance,
  options: HttpSecurityOptions,
): void {
  if (options.allowedOrigins.length === 0) {
    throw new Error(
      "At least one allowed CORS origin must be configured.",
    );
  }

  // Add common HTTP security headers.
  server.register(helmet);

  // Enable secure cookie parsing and serialization.
  server.register(cookie);

  // Permit only explicitly configured browser origins.
  server.register(cors, {
    origin: options.allowedOrigins,
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PATCH",
      "PUT",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
    maxAge: 600,
  });

  // Individual routes choose their own rate limits.
  server.register(rateLimit, {
    global: false,
  });
}
