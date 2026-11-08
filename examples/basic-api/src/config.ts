import { z } from "zod";

import {
  ConfigValidationError,
  loadConfig,
  type ConfigSource,
} from "@sethi-backend/config";
import {
  normalizeAllowedOrigins,
} from "@sethi-backend/adapter-fastify";

/**
 * Validate the MongoDB connection string.
 */
const mongoUriSchema = z
  .string()
  .trim()
  .min(1, "MongoDB connection URI is required.")
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);

        return (
          parsed.protocol === "mongodb:" ||
          parsed.protocol === "mongodb+srv:"
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Must be a valid mongodb:// or mongodb+srv:// URI.",
    },
  );

const optionalEnvironmentString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === ""
    ? undefined
    : value,
  z.string().trim().min(1).optional(),
);

const optionalUrlSchema = optionalEnvironmentString.refine((value) => {
  if (!value) {
    return true;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}, "APP_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.");

const optionalRedisUrlSchema = optionalEnvironmentString.refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ["redis:", "rediss:"].includes(url.protocol) &&
      url.hostname.length > 0 &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
}, "REDIS_URL must be a redis:// or rediss:// URL.");

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Environment configuration schema.
 */
const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  HOST: z
    .string()
    .trim()
    .min(1, "HOST cannot be empty.")
    .default("127.0.0.1"),

  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(3000),

  MONGODB_URI: mongoUriSchema,

  MONGODB_DATABASE: z
    .string()
    .trim()
    .min(1, "Database name cannot be empty.")
    .default("sethi_backend_dev"),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must contain at least 32 characters."),

  JWT_ISSUER: z.string().trim().min(1).default("sethi-backend"),

  JWT_AUDIENCE: z.string().trim().min(1).default("sethi-backend-api"),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(900),

  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  RATE_LIMIT_STORE: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: optionalRedisUrlSchema,

  SMTP_HOST: optionalEnvironmentString,
  SMTP_PORT: z.preprocess(
    (value) => typeof value === "string" && value.trim() === ""
      ? undefined
      : value,
    z.coerce.number().int().min(1).max(65535).default(587),
  ),
  SMTP_SECURE: z.preprocess(
    (value) => typeof value === "string" && value.trim() === ""
      ? undefined
      : value,
    z.enum(["true", "false"]).default("false"),
  ).transform((value) => value === "true"),
  SMTP_USER: optionalEnvironmentString,
  SMTP_PASSWORD: optionalEnvironmentString,
  EMAIL_FROM: optionalEnvironmentString,
  APP_BASE_URL: optionalUrlSchema,
  EMAIL_VERIFICATION_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .default(24 * 60 * 60),
  PASSWORD_RESET_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .default(30 * 60),
}).superRefine((env, context) => {
  const production = env.NODE_ENV === "production";

  if (
    production &&
    env.APP_BASE_URL &&
    !isHttpsUrl(env.APP_BASE_URL)
  ) {
    context.addIssue({
      code: "custom",
      path: ["APP_BASE_URL"],
      message: "APP_BASE_URL must use HTTPS in production.",
    });
  }
  if (env.RATE_LIMIT_STORE === "redis" && !env.REDIS_URL) {
    context.addIssue({
      code: "custom",
      path: ["REDIS_URL"],
      message: "REDIS_URL is required when RATE_LIMIT_STORE=redis.",
    });
  }
  if (
    production &&
    (
      new Set(env.JWT_SECRET).size < 8 ||
      /^(.)\1+$/.test(env.JWT_SECRET) ||
      /(change.?me|replace.?with|your.?secret|example.?secret|test.?only|password)/i.test(env.JWT_SECRET)
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["JWT_SECRET"],
      message: "JWT_SECRET must not be a placeholder or repetitive value in production.",
    });
  }

  const smtpConfigured = Boolean(
    env.SMTP_HOST || env.SMTP_USER || env.SMTP_PASSWORD || env.EMAIL_FROM,
  );
  if (!smtpConfigured && !production) {
    return;
  }
  if (!env.SMTP_HOST) {
    context.addIssue({
      code: "custom",
      path: ["SMTP_HOST"],
      message: "SMTP_HOST is required when SMTP is configured.",
    });
  }
  if (!env.EMAIL_FROM) {
    context.addIssue({
      code: "custom",
      path: ["EMAIL_FROM"],
      message: "EMAIL_FROM is required when SMTP is configured.",
    });
  }
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
    context.addIssue({
      code: "custom",
      path: ["SMTP_USER"],
      message: "SMTP_USER and SMTP_PASSWORD must be configured together.",
    });
  }
  if (!env.APP_BASE_URL) {
    context.addIssue({
      code: "custom",
      path: ["APP_BASE_URL"],
      message: "APP_BASE_URL is required when SMTP is configured.",
    });
  }
});

/**
 * Load and return typed application configuration.
 */
export function loadAppConfig(
  source: ConfigSource = process.env,
) {
  const env = loadConfig(environmentSchema, source);
  if (env.NODE_ENV === "production") {
    if (!source.CORS_ORIGINS?.trim()) {
      throw new ConfigValidationError(
        "Production configuration requires an explicit CORS_ORIGINS allowlist.",
      );
    }
    if (
      !source.MONGODB_DATABASE?.trim() ||
      env.MONGODB_DATABASE === "sethi_backend_dev"
    ) {
      throw new ConfigValidationError(
        "Production configuration requires an explicit non-development MONGODB_DATABASE.",
      );
    }
  }
  let corsOrigins: string[];
  try {
    corsOrigins = normalizeAllowedOrigins(env.CORS_ORIGINS, env.NODE_ENV);
  } catch {
    throw new ConfigValidationError(
      "CORS_ORIGINS contains an invalid origin for this environment.",
    );
  }
  if (env.NODE_ENV === "production") {
    if (env.RATE_LIMIT_STORE !== "redis" || !env.REDIS_URL) {
      throw new ConfigValidationError(
        "Production requires RATE_LIMIT_STORE=redis and REDIS_URL.",
      );
    }
    if (new URL(env.REDIS_URL).protocol !== "rediss:") {
      throw new ConfigValidationError(
        "Production REDIS_URL must use TLS (rediss://).",
      );
    }
  }

  return {
    environment: env.NODE_ENV,

    server: {
      host: env.HOST,
      port: env.PORT,
    },

    mongodb: {
      uri: env.MONGODB_URI,
      databaseName: env.MONGODB_DATABASE,
    },

    tokens: {
      secret: env.JWT_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    },

    httpSecurity: {
      corsOrigins,
      rateLimitStore: env.RATE_LIMIT_STORE,
      redisUrl: env.REDIS_URL,
    },

    email: {
      appBaseUrl: env.APP_BASE_URL,
      emailVerificationTokenTtlSeconds:
        env.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
      passwordResetTokenTtlSeconds:
        env.PASSWORD_RESET_TOKEN_TTL_SECONDS,
      smtp: env.SMTP_HOST && env.EMAIL_FROM
        ? {
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          from: env.EMAIL_FROM,
          ...(env.NODE_ENV === "production" && !env.SMTP_SECURE
            ? { requireTLS: true }
            : {}),
          ...(env.SMTP_USER ? { username: env.SMTP_USER } : {}),
          ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
        }
        : undefined,
    },
  };
}

export type AppConfig = ReturnType<typeof loadAppConfig>;