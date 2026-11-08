import {
  describe,
  expect,
  it,
} from "vitest";

import { loadAppConfig } from "../src/config.js";

const validMongoUri = "mongodb://127.0.0.1:27017";

const testJwtSecret =
  "test-only-secret-0123456789abcdef-0123456789";
const productionJwtSecret =
  "8X!q4m#Zp2V$w7K@e5R!n3L&b9C^s6TQ";

describe("Application Configuration", () => {
  it("should apply default configuration values", () => {
    const config = loadAppConfig({
      MONGODB_URI: validMongoUri,
      JWT_SECRET: testJwtSecret,
    });

    expect(config).toEqual({
      environment: "development",

      server: {
        host: "127.0.0.1",
        port: 3000,
      },

      mongodb: {
        uri: validMongoUri,
        databaseName: "sethi_backend_dev",
      },

      httpSecurity: {
        corsOrigins: ["http://localhost:5173"],
        rateLimitStore: "memory",
        redisUrl: undefined,
      },

      tokens: {
        secret: testJwtSecret,
        issuer: "sethi-backend",
        audience: "sethi-backend-api",
        accessTokenTtlSeconds: 900,
      },
      email: {
        appBaseUrl: undefined,
        emailVerificationTokenTtlSeconds: 86400,
        passwordResetTokenTtlSeconds: 1800,
        smtp: undefined,
      },
    });
  });

  it("should accept custom environment values", () => {
    const config = loadAppConfig({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "8080",
      MONGODB_URI: validMongoUri,
      MONGODB_DATABASE: "production_db",
      CORS_ORIGINS: "https://frontend.example",
      JWT_SECRET: productionJwtSecret,
      SMTP_HOST: "smtp.example.com",
      EMAIL_FROM: "no-reply@example.com",
      APP_BASE_URL: "https://frontend.example",
      RATE_LIMIT_STORE: "redis",
      REDIS_URL: "rediss://redis.example.com:6379",
    });

    expect(config).toEqual({
      environment: "production",

      server: {
        host: "0.0.0.0",
        port: 8080,
      },

      mongodb: {
        uri: validMongoUri,
        databaseName: "production_db",
      },

      httpSecurity: {
        corsOrigins: ["https://frontend.example"],
        rateLimitStore: "redis",
        redisUrl: "rediss://redis.example.com:6379",
      },

      tokens: {
        secret: productionJwtSecret,
        issuer: "sethi-backend",
        audience: "sethi-backend-api",
        accessTokenTtlSeconds: 900,
      },
      email: {
        appBaseUrl: "https://frontend.example",
        emailVerificationTokenTtlSeconds: 86400,
        passwordResetTokenTtlSeconds: 1800,
        smtp: {
          host: "smtp.example.com",
          port: 587,
          secure: false,
          requireTLS: true,
          from: "no-reply@example.com",
        },
      },
    });
  });

  it("requires explicit production origins, database, SMTP, and a non-placeholder secret", () => {
    const productionBase = {
      NODE_ENV: "production",
      MONGODB_URI: validMongoUri,
      MONGODB_DATABASE: "production_db",
      CORS_ORIGINS: "https://frontend.example",
      JWT_SECRET: productionJwtSecret,
      SMTP_HOST: "smtp.example.com",
      EMAIL_FROM: "no-reply@example.com",
      APP_BASE_URL: "https://frontend.example",
      RATE_LIMIT_STORE: "redis",
      REDIS_URL: "rediss://redis.example.com:6379",
    };

    expect(() => loadAppConfig({
      ...productionBase,
      JWT_SECRET: "replace-with-a-random-secret-at-least-32-bytes-long",
    })).toThrow("placeholder or repetitive");

    expect(() => loadAppConfig({
      ...productionBase,
      CORS_ORIGINS: undefined,
    })).toThrow("explicit CORS_ORIGINS");

    expect(() => loadAppConfig({
      ...productionBase,
      MONGODB_DATABASE: "sethi_backend_dev",
    })).toThrow("non-development MONGODB_DATABASE");

    expect(() => loadAppConfig({
      NODE_ENV: "production",
      MONGODB_URI: validMongoUri,
      MONGODB_DATABASE: "production_db",
      CORS_ORIGINS: "https://frontend.example",
      JWT_SECRET: productionJwtSecret,
      RATE_LIMIT_STORE: "redis",
      REDIS_URL: "rediss://redis.example.com:6379",
    })).toThrow("SMTP_HOST");
  });

  it("should normalize and validate configured CORS origins", () => {
    const config = loadAppConfig({
      MONGODB_URI: validMongoUri,
      JWT_SECRET: testJwtSecret,
      CORS_ORIGINS: " https://example.com:443/ ,https://example.com",
    });

    expect(config.httpSecurity.corsOrigins).toEqual([
      "https://example.com",
    ]);
  });

  it.each([
    ["empty", ""],
    ["wildcard", "*"],
    ["opaque null", "null"],
    ["invalid", "not a URL"],
    ["HTTP in production", "http://example.com"],
  ])("should reject %s CORS origins", (_description, origins) => {
    expect(() =>
      loadAppConfig({
        NODE_ENV: origins === "http://example.com"
          ? "production"
          : "development",
        MONGODB_URI: validMongoUri,
        JWT_SECRET: testJwtSecret,
        CORS_ORIGINS: origins,
      }),
    ).toThrow();
  });

  it("should reject an invalid server port", () => {
    expect(() =>
      loadAppConfig({
        MONGODB_URI: validMongoUri,
        JWT_SECRET: testJwtSecret,
        PORT: "70000",
      }),
    ).toThrow("PORT");
  });

  it("should reject an invalid MongoDB URI scheme", () => {
    expect(() =>
      loadAppConfig({
        MONGODB_URI: "https://example.com",
        JWT_SECRET: testJwtSecret,
      }),
    ).toThrow("MONGODB_URI");
  });

  it("should reject a missing MongoDB URI", () => {
    expect(() =>
      loadAppConfig({}),
    ).toThrow("MONGODB_URI");
  });

  it("validates complete SMTP settings and application URL", () => {
    const config = loadAppConfig({
      MONGODB_URI: validMongoUri,
      JWT_SECRET: testJwtSecret,
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "smtp-user",
      SMTP_PASSWORD: "smtp-password",
      EMAIL_FROM: "no-reply@example.com",
      APP_BASE_URL: "https://frontend.example",
    });

    expect(config.email).toEqual({
      appBaseUrl: "https://frontend.example",
      emailVerificationTokenTtlSeconds: 86400,
      passwordResetTokenTtlSeconds: 1800,
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        from: "no-reply@example.com",
        username: "smtp-user",
        password: "smtp-password",
      },
    });
    expect(() => loadAppConfig({
      MONGODB_URI: validMongoUri,
      JWT_SECRET: testJwtSecret,
      SMTP_HOST: "smtp.example.com",
      EMAIL_FROM: "no-reply@example.com",
    })).toThrow("APP_BASE_URL");
  });
});