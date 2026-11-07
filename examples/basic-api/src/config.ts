import { z } from "zod";

import {
  loadConfig,
  type ConfigSource,
} from "@sethi-backend/config";

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
    .min(32, "usmansethi60906230126billi")
    .default("0123456789abcdef0123456789abcdef"),

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
  };
}

export type AppConfig = ReturnType<typeof loadAppConfig>;