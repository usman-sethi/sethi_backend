import { z } from "zod";

import {
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
});

/**
 * Load and return typed application configuration.
 */
export function loadAppConfig(
  source: ConfigSource = process.env,
) {
  const env = loadConfig(environmentSchema, source);
  const corsOrigins = normalizeAllowedOrigins(
    env.CORS_ORIGINS,
    env.NODE_ENV,
  );

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
    },
  };
}

export type AppConfig = ReturnType<typeof loadAppConfig>;