
import { describe, it, expect } from "vitest";

import { createBackend } from "../src/application.js";

describe("Backend Application", () => {
  it("should start database before HTTP server", async () => {
    const events: string[] = [];

    const app = createBackend({
      server: {
        host: "127.0.0.1",
        port: 4000,
      },

      database: {
        async connect() {
          events.push("database:connect");
        },

        async disconnect() {
          events.push("database:disconnect");
        },
      },

      adapter: {
        async start() {
          events.push("server:start");
        },

        async stop() {
          events.push("server:stop");
        },
      },
    });

    await app.start();

    expect(events).toEqual([
      "database:connect",
      "server:start",
    ]);

    expect(app.getState()).toBe("running");

    await app.stop();

    expect(events).toEqual([
      "database:connect",
      "server:start",
      "server:stop",
      "database:disconnect",
    ]);

    expect(app.getState()).toBe("stopped");
  });

  it("should clean up database if server startup fails", async () => {
    const events: string[] = [];

    const app = createBackend({
      server: {
        host: "127.0.0.1",
        port: 4000,
      },

      database: {
        async connect() {
          events.push("database:connect");
        },

        async disconnect() {
          events.push("database:disconnect");
        },
      },

      adapter: {
        async start() {
          events.push("server:start");

          throw new Error("HTTP startup failed");
        },

        async stop() {
          events.push("server:cleanup");
        },
      },
    });

    await expect(app.start()).rejects.toThrow(
      "HTTP startup failed",
    );

    expect(events).toEqual([
      "database:connect",
      "server:start",
      "server:cleanup",
      "database:disconnect",
    ]);

    expect(app.getState()).toBe("idle");
  });

  it("should not shut down resources twice", async () => {
    let disconnectCount = 0;
    let stopCount = 0;

    const app = createBackend({
      server: {
        host: "127.0.0.1",
        port: 4000,
      },

      database: {
        async connect() {},

        async disconnect() {
          disconnectCount++;
        },
      },

      adapter: {
        async start() {},

        async stop() {
          stopCount++;
        },
      },
    });

    await app.start();

    await app.stop();
    await app.stop();

    expect(disconnectCount).toBe(1);
    expect(stopCount).toBe(1);
  });

  it("should reject starting after shutdown", async () => {
    const app = createBackend({
      server: {
        host: "127.0.0.1",
        port: 4000,
      },

      database: {
        async connect() {},
        async disconnect() {},
      },

      adapter: {
        async start() {},
        async stop() {},
      },
    });

    await app.stop();

    await expect(app.start()).rejects.toThrow(
      'Cannot start backend while state is "stopped".',
    );
  });
});
