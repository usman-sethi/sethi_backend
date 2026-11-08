import Fastify, { type FastifyInstance } from "fastify";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  createRedisRateLimitClient,
  registerHttpSecurity,
} from "../src/index.js";

const configuredRedisUrl = process.env.TEST_REDIS_URL;
if (!configuredRedisUrl) {
  throw new Error("TEST_REDIS_URL is required for Redis integration tests.");
}
const redisUrl = new URL(configuredRedisUrl);
if (
  !["redis:", "rediss:"].includes(redisUrl.protocol) ||
  !["localhost", "127.0.0.1", "::1"].includes(
    redisUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
  ) ||
  redisUrl.username ||
  redisUrl.password
) {
  throw new Error(
    "TEST_REDIS_URL must target a local Redis server without credentials.",
  );
}

describe("Redis-backed distributed rate limits", () => {
  const servers: FastifyInstance[] = [];
  const namespace = `sethi-test:${crypto.randomUUID()}:`;

  beforeAll(async () => {
    for (let index = 0; index < 2; index += 1) {
      const server = Fastify();
      const redis = createRedisRateLimitClient({ url: configuredRedisUrl });
      registerHttpSecurity(server, {
        allowedOrigins: ["http://localhost:5173"],
        environment: "test",
        rateLimit: {
          store: "redis",
          redis,
          namespace,
        },
      });
      server.get("/shared-limit", {
        config: { rateLimit: { max: 1, timeWindow: 60_000 } },
      }, async () => ({ status: "ok" }));
      await server.ready();
      servers.push(server);
    }
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  it("shares the route quota across independent Fastify instances", async () => {
    expect((await servers[0]!.inject("/shared-limit")).statusCode).toBe(200);
    expect((await servers[1]!.inject("/shared-limit")).statusCode).toBe(429);
  });
});
