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
});