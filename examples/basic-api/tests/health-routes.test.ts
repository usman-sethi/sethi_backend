import { afterEach, describe, expect, it } from "vitest";

import { createFastifyAdapter } from "@sethi-backend/adapter-fastify";

import { registerHealthRoutes } from "../src/health-routes.js";

describe("health routes", () => {
  let server: ReturnType<typeof createFastifyAdapter>["instance"] | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reports liveness independently of database readiness", async () => {
    const adapter = createFastifyAdapter();
    server = adapter.instance;
    registerHealthRoutes(server, async () => {
      throw new Error("database credentials must not be exposed");
    });

    const health = await server.inject({ method: "GET", url: "/health" });
    const readiness = await server.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ok",
      service: "sethi-backend",
    });
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({
      status: "not_ready",
      database: "unavailable",
    });
    expect(readiness.body).not.toContain("credentials");
  });

  it("reports readiness when its dependency check succeeds", async () => {
    const adapter = createFastifyAdapter();
    server = adapter.instance;
    registerHealthRoutes(server, async () => {});

    const response = await server.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      database: "reachable",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
