import { describe, expect, it } from "vitest";

import { createBackend } from "@sethi-backend/core";

import { createFastifyAdapter } from "../src/index.js";

describe("Fastify Adapter", () => {
  it("should serve HTTP requests through the core application", async () => {
    const events: string[] = [];

    const adapter = createFastifyAdapter();

    // Register a health-check route.
    adapter.instance.get("/health", async () => {
      return {
        status: "ok",
        service: "sethi-backend",
      };
    });

    // Temporary database implementation.
    // MongoDB adapter will be built on Day 4.
    const app = createBackend({
      server: {
        host: "127.0.0.1",
        port: 0,
      },

      adapter,

      database: {
        async connect() {
          events.push("database:connect");
        },

        async disconnect() {
          events.push("database:disconnect");
        },
      },
    });

    let started = false;

    try {
      await app.start();
      started = true;

      const address = adapter.instance.server.address();

      if (!address || typeof address === "string") {
        throw new Error("Could not determine HTTP server address.");
      }

      const response = await fetch(
        `http://127.0.0.1:${address.port}/health`,
      );

      expect(response.status).toBe(200);

      expect(await response.json()).toEqual({
        status: "ok",
        service: "sethi-backend",
      });

      expect(events).toEqual([
        "database:connect",
      ]);

      expect(app.getState()).toBe("running");
    } finally {
      if (started) {
        await app.stop();
      }
    }

    expect(events).toEqual([
      "database:connect",
      "database:disconnect",
    ]);

    expect(app.getState()).toBe("stopped");
  });

  it("should reject starting an already running server", async () => {
    const adapter = createFastifyAdapter();

    const options = {
      host: "127.0.0.1",
      port: 0,
    };

    try {
      await adapter.start(options);

      await expect(
        adapter.start(options),
      ).rejects.toThrow(
        'Cannot start Fastify adapter while state is "running".',
      );
    } finally {
      await adapter.stop();
    }
  });

  it("should allow repeated shutdown calls", async () => {
    const adapter = createFastifyAdapter();

    await adapter.start({
      host: "127.0.0.1",
      port: 0,
    });

    await adapter.stop();

    await expect(
      adapter.stop(),
    ).resolves.toBeUndefined();
  });

  it("uses a server-generated request ID and redacts sensitive log fields", async () => {
    const output: string[] = [];
    const secret = "sensitive-test-token";
    const adapter = createFastifyAdapter({
      logger: {
        level: "info",
        stream: {
          write(message) {
            output.push(message);
          },
        },
      },
    });

    adapter.instance.get("/failure", async (request) => {
      request.log.info({
        password: secret,
        refreshToken: secret,
      }, "redaction test");
      throw new Error(secret);
    });

    try {
      const response = await adapter.instance.inject({
        method: "GET",
        url: "/failure",
        headers: { "x-request-id": "untrusted-client-id" },
      });
      const requestId = response.headers["x-request-id"];

      expect(response.statusCode).toBe(500);
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.json()).toMatchObject({
        error: {
          code: "INTERNAL_ERROR",
          requestId,
        },
      });
      expect(response.body).not.toContain(secret);
      expect(output.join("")).not.toContain(secret);
      expect(output.join("")).toContain("[REDACTED]");

      const missing = await adapter.instance.inject({
        method: "GET",
        url: "/missing?token=sensitive-not-found-token",
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        error: {
          code: "NOT_FOUND",
          message: "Not found.",
          requestId: missing.headers["x-request-id"],
        },
      });
      expect(missing.body).not.toContain("sensitive-not-found-token");
    } finally {
      await adapter.instance.close();
    }
  });

  it("can retry startup after a port conflict and cleanup", async () => {
    const holder = createFastifyAdapter();
    const retryable = createFastifyAdapter();
    await holder.start({
      host: "127.0.0.1",
      port: 0,
    });
    const port = holder.instance.server.address();
    if (!port || typeof port === "string") {
      await holder.stop();
      throw new Error("Could not determine the occupied HTTP port.");
    }

    try {
      await expect(retryable.start({
        host: "127.0.0.1",
        port: port.port,
      })).rejects.toThrow();
      await retryable.stop();
    } finally {
      await holder.stop();
    }

    try {
      await expect(retryable.start({
        host: "127.0.0.1",
        port: port.port,
      })).resolves.toBeUndefined();
    } finally {
      await retryable.stop();
    }
  });
});