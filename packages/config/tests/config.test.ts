import {
  describe,
  expect,
  it,
} from "vitest";

import { z } from "zod";

import { loadConfig } from "../src/index.js";

describe("Configuration Loader", () => {
  it("should validate and transform configuration", () => {
    const schema = z.object({
      APP_NAME: z.string().trim().min(1),
      PORT: z.coerce.number().int().min(1).max(65535),
    });

    const config = loadConfig(schema, {
      APP_NAME: " Sethi Backend ",
      PORT: "4000",
    });

    expect(config).toEqual({
      APP_NAME: "Sethi Backend",
      PORT: 4000,
    });
  });

  it("should apply default values", () => {
    const schema = z.object({
      HOST: z.string().default("127.0.0.1"),
      PORT: z.coerce.number().default(3000),
    });

    const config = loadConfig(schema, {});

    expect(config).toEqual({
      HOST: "127.0.0.1",
      PORT: 3000,
    });
  });

  it("should reject invalid configuration", () => {
    const schema = z.object({
      PORT: z.coerce.number().int().min(1).max(65535),
    });

    expect(() =>
      loadConfig(schema, {
        PORT: "70000",
      }),
    ).toThrow("PORT");
  });

  it("should not expose secret values in validation errors", () => {
    const secret = "short-secret";

    const schema = z.object({
      API_SECRET: z.string().min(
        20,
        "API_SECRET must contain at least 20 characters.",
      ),
    });

    let errorMessage = "";

    try {
      loadConfig(schema, {
        API_SECRET: secret,
      });
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("API_SECRET");
    expect(errorMessage).not.toContain(secret);
  });
});