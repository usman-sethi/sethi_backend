import {
  describe,
  expect,
  it,
} from "vitest";

import { loadAppConfig } from "../src/config.js";

const validMongoUri = "mongodb://127.0.0.1:27017";

const testJwtSecret =
  "0123456789abcdef-0123456789abcdef";
  
describe("Application Configuration", () => {
  it("should apply default configuration values", () => {
    const config = loadAppConfig({
      MONGODB_URI: validMongoUri,
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
      JWT_SECRET: testJwtSecret,
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
      },
    });
  });

  it("should normalize and validate configured CORS origins", () => {
    const config = loadAppConfig({
      MONGODB_URI: validMongoUri,
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
        CORS_ORIGINS: origins,
      }),
    ).toThrow();
  });

  it("should reject an invalid server port", () => {
    expect(() =>
      loadAppConfig({
        MONGODB_URI: validMongoUri,
        PORT: "70000",
      }),
    ).toThrow("PORT");
  });

  it("should reject an invalid MongoDB URI scheme", () => {
    expect(() =>
      loadAppConfig({
        MONGODB_URI: "https://example.com",
      }),
    ).toThrow("MONGODB_URI");
  });

  it("should reject a missing MongoDB URI", () => {
    expect(() =>
      loadAppConfig({}),
    ).toThrow("MONGODB_URI");
  });
});