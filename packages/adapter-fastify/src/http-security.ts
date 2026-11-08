import type { CookieSerializeOptions } from "@fastify/cookie";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import csrfProtection from "@fastify/csrf-protection";
import type { FastifyHelmetOptions } from "@fastify/helmet";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import type {
  FastifyInstance,
  FastifyReply,
  onRequestHookHandler,
} from "fastify";

export type HttpSecurityEnvironment =
  | "development"
  | "test"
  | "production";

export interface HttpSecurityOptions {
  allowedOrigins: readonly string[];
  environment?: HttpSecurityEnvironment;
  helmet?: Pick<
    FastifyHelmetOptions,
    "contentSecurityPolicy" | "crossOriginResourcePolicy" | "referrerPolicy"
  >;
  cors?: {
    methods?: readonly string[];
    allowedHeaders?: readonly string[];
    exposedHeaders?: readonly string[];
    maxAgeSeconds?: number;
  };
  csrf?: {
    enabled?: boolean;
    cookieKey?: string;
  };
  rateLimit?: {
    enabled?: boolean;
    store?: "memory" | "redis";
    redis?: Redis;
    namespace?: string;
  };
}

const registeredServers = new WeakSet<FastifyInstance>();

/**
 * Validate and canonicalize an explicit browser-origin allowlist.
 */
export function normalizeAllowedOrigins(
  allowedOrigins: readonly string[],
  environment: HttpSecurityEnvironment = "development",
): string[] {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new Error("At least one allowed CORS origin must be configured.");
  }

  const normalizedOrigins = new Set<string>();

  for (const candidate of allowedOrigins) {
    if (typeof candidate !== "string") {
      throw new TypeError("CORS origins must be strings.");
    }

    const value = candidate.trim();

    if (value.length === 0 || value === "*" || value.toLowerCase() === "null") {
      throw new Error(`Invalid CORS origin: "${value}".`);
    }

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid CORS origin: "${value}".`);
    }

    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin === "null" ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error(`Invalid CORS origin: "${value}".`);
    }

    if (environment === "production" && parsed.protocol !== "https:") {
      throw new Error(
        `CORS origin "${value}" must use HTTPS in production.`,
      );
    }

    normalizedOrigins.add(parsed.origin);
  }

  if (normalizedOrigins.size === 0) {
    throw new Error("At least one allowed CORS origin must be configured.");
  }

  return [...normalizedOrigins];
}

/**
 * Cookie attributes suitable for HTTP security-sensitive cookies.
 */
export function getHttpCookieOptions(
  environment: HttpSecurityEnvironment = "development",
): CookieSerializeOptions {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: environment === "production",
  };
}

/**
 * Register common HTTP security plugins before registering application routes.
 *
 * CSRF verification is exposed as a route hook; it is deliberately not applied
 * globally so bearer-token and public routes are not forced to use CSRF tokens.
 */
export function registerHttpSecurity(
  server: FastifyInstance,
  options: HttpSecurityOptions,
): void {
  if (registeredServers.has(server)) {
    throw new Error("HTTP security has already been registered on this server.");
  }

  const environment = options.environment ?? "development";
  const allowedOrigins = normalizeAllowedOrigins(
    options.allowedOrigins,
    environment,
  );
  const methods = options.cors?.methods ?? [
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ];
  const allowedHeaders = options.cors?.allowedHeaders ?? [
    "Content-Type",
    "Authorization",
    "X-CSRF-Token",
  ];
  const exposedHeaders = options.cors?.exposedHeaders ?? ["X-Request-Id"];
  const maxAgeSeconds = options.cors?.maxAgeSeconds ?? 600;

  if (methods.length === 0 || methods.some((method) => !method.trim())) {
    throw new Error("CORS methods must contain at least one non-empty value.");
  }

  if (
    allowedHeaders.length === 0 ||
    allowedHeaders.some((header) => !header.trim())
  ) {
    throw new Error(
      "CORS allowed headers must contain at least one non-empty value.",
    );
  }

  if (exposedHeaders.some((header) => !header.trim())) {
    throw new Error("CORS exposed headers cannot contain empty values.");
  }

  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new RangeError("CORS max-age must be a non-negative integer.");
  }

  if (options.csrf?.cookieKey !== undefined && !options.csrf.cookieKey.trim()) {
    throw new Error("The CSRF cookie name cannot be empty.");
  }

  const rateLimitStore = options.rateLimit?.store ??
    (environment === "production" ? undefined : "memory");
  if (options.rateLimit?.enabled !== false && environment === "production" &&
      rateLimitStore !== "redis") {
    throw new Error(
      "Production rate limiting requires the explicit Redis store.",
    );
  }
  if (rateLimitStore === "redis" && !options.rateLimit?.redis) {
    throw new Error(
      "Redis rate limiting requires a dedicated Redis client.",
    );
  }
  if (
    options.rateLimit?.namespace !== undefined &&
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(options.rateLimit.namespace)
  ) {
    throw new Error("Rate-limit namespace contains invalid characters.");
  }

  registeredServers.add(server);
  const routeRateLimitHandlers = new Map<
    string,
    ReturnType<FastifyInstance["rateLimit"]>
  >();

  if (options.helmet) {
    server.register(helmet, options.helmet);
  } else {
    server.register(helmet);
  }

  server.register(cookie);
  server.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: [...methods],
    allowedHeaders: [...allowedHeaders],
    exposedHeaders: [...exposedHeaders],
    maxAge: maxAgeSeconds,
    strictPreflight: true,
  });

  if (options.rateLimit?.enabled !== false) {
    server.addHook("preHandler", async (request, reply) => {
      const routeLimit = request.routeOptions.config.rateLimit;

      if (!routeLimit || typeof routeLimit !== "object") {
        return;
      }

      const routeKey = `${String(request.routeOptions.method)} ${request.routeOptions.url}`;
      let rateLimitHook = routeRateLimitHandlers.get(routeKey);
      if (!rateLimitHook) {
        rateLimitHook = server.rateLimit(routeLimit);
        routeRateLimitHandlers.set(routeKey, rateLimitHook);
      }

      return rateLimitHook.call(server, request, reply);
    });
  }

  if (options.csrf?.enabled !== false) {
    const csrfOptions = {
      cookieOpts: getHttpCookieOptions(environment),
      sessionPlugin: "@fastify/cookie" as const,
      ...(options.csrf?.cookieKey
        ? { cookieKey: options.csrf.cookieKey }
        : {}),
    };

    server.register(csrfProtection, {
      ...csrfOptions,
    });
  }

  if (options.rateLimit?.enabled !== false) {
    const redisClient = rateLimitStore === "redis"
      ? options.rateLimit?.redis
      : undefined;
    if (redisClient) {
      server.addHook("onReady", async () => {
        if (redisClient.status === "wait") {
          await redisClient.connect();
        }
        if (redisClient.status !== "ready") {
          throw new Error(
            "Redis is unavailable; distributed rate limiting cannot start.",
          );
        }
      });
      server.addHook("onClose", async () => {
        if (redisClient.status === "ready") {
          await redisClient.quit();
        } else {
          redisClient.disconnect();
        }
      });
    }
    server.register(rateLimit, {
      global: false,
      skipOnError: false,
      ...(redisClient
        ? {
          redis: redisClient,
          nameSpace: options.rateLimit?.namespace ?? "sethi:ratelimit:",
        }
        : {}),
    });
  }
}

export interface RedisRateLimitClientOptions {
  url: string;
  connectTimeout?: number;
}

/**
 * Create a dedicated, lazily connected Redis client for one Fastify instance.
 * Register it with `registerHttpSecurity`; the server connects before listening
 * and closes the client during shutdown.
 */
export function createRedisRateLimitClient(
  options: RedisRateLimitClientOptions,
): Redis {
  const url = options.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("Redis URL must be a valid redis:// or rediss:// URL.");
  }
  if (
    !["redis:", "rediss:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    (options.connectTimeout !== undefined &&
      (!Number.isInteger(options.connectTimeout) ||
        options.connectTimeout < 100 ||
        options.connectTimeout > 60_000))
  ) {
    throw new TypeError("Redis rate-limit connection options are invalid.");
  }
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: options.connectTimeout ?? 5_000,
  });
}

/**
 * Create a route hook that verifies a CSRF token for a protected route.
 */
export function createCsrfProtectionHook(
  server: FastifyInstance,
): onRequestHookHandler {
  return (request, reply, done) => {
    server.csrfProtection(request, reply, done);
  };
}

/**
 * Generate a CSRF token in a route handler.
 */
export function generateCsrfToken(reply: FastifyReply): string {
  return reply.generateCsrf();
}
