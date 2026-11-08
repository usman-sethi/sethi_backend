import Fastify from "fastify";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createCsrfProtectionHook,
  generateCsrfToken,
  getHttpCookieOptions,
  normalizeAllowedOrigins,
  registerHttpSecurity,
} from "../src/index.js";

const allowedOrigins = ["http://localhost:5173"];

describe("Fastify HTTP security", () => {
  let server: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function createServer(
    options: Parameters<typeof registerHttpSecurity>[1] = {
      allowedOrigins,
    },
  ): ReturnType<typeof Fastify> {
    server = Fastify();
    registerHttpSecurity(server, options);
    return server;
  }

  it("normalizes explicit HTTP and HTTPS origins", () => {
    expect(
      normalizeAllowedOrigins([
        " HTTPS://Example.com:443/ ",
        "https://example.com",
        "http://localhost:5173/",
      ]),
    ).toEqual([
      "https://example.com",
      "http://localhost:5173",
    ]);
  });

  it.each([
    ["empty allowlist", []],
    ["wildcard", ["*"]],
    ["opaque null origin", ["null"]],
    ["invalid URL", ["not a URL"]],
    ["unsupported scheme", ["ftp://example.com"]],
    ["path in origin", ["https://example.com/api"]],
    ["credentials in URL", ["https://user:pass@example.com"]],
  ])("rejects %s", (_description, origins) => {
    expect(() => normalizeAllowedOrigins(origins)).toThrow();
  });

  it("requires HTTPS origins in production", () => {
    expect(() =>
      normalizeAllowedOrigins(["http://example.com"], "production"),
    ).toThrow("must use HTTPS in production");

    expect(
      normalizeAllowedOrigins(["https://example.com"], "production"),
    ).toEqual(["https://example.com"]);
  });

  it("rejects duplicate security plugin registration", () => {
    const app = Fastify();
    server = app;

    registerHttpSecurity(app, { allowedOrigins });

    expect(() =>
      registerHttpSecurity(app, { allowedOrigins }),
    ).toThrow("already been registered");
  });

  it("adds Helmet headers and only grants CORS to configured origins", async () => {
    const app = createServer({
      allowedOrigins,
      helmet: {
        crossOriginResourcePolicy: false,
      },
    });

    app.get("/resource", async () => ({ status: "ok" }));

    const allowedResponse = await app.inject({
      method: "GET",
      url: "/resource",
      headers: {
        origin: allowedOrigins[0],
      },
    });

    expect(allowedResponse.statusCode).toBe(200);
    expect(allowedResponse.headers["x-content-type-options"]).toBe("nosniff");
    expect(allowedResponse.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(allowedResponse.headers["access-control-allow-origin"]).toBe(
      allowedOrigins[0],
    );
    expect(allowedResponse.headers["access-control-allow-credentials"]).toBe(
      "true",
    );
    expect(allowedResponse.headers["access-control-expose-headers"]).toContain(
      "X-Request-Id",
    );
    expect(
      allowedResponse.headers["cross-origin-resource-policy"],
    ).toBeUndefined();

    const rejectedOriginResponse = await app.inject({
      method: "GET",
      url: "/resource",
      headers: {
        origin: "https://untrusted.example",
      },
    });

    expect(rejectedOriginResponse.statusCode).toBe(200);
    expect(
      rejectedOriginResponse.headers["access-control-allow-origin"],
    ).toBeUndefined();
  });

  it("handles allowed preflight requests without reflecting an unapproved origin", async () => {
    const app = createServer();
    app.post("/resource", async () => ({ status: "ok" }));

    const allowedPreflight = await app.inject({
      method: "OPTIONS",
      url: "/resource",
      headers: {
        origin: allowedOrigins[0],
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-csrf-token",
      },
    });

    expect(allowedPreflight.statusCode).toBe(204);
    expect(allowedPreflight.headers["access-control-allow-origin"]).toBe(
      allowedOrigins[0],
    );
    expect(allowedPreflight.headers["access-control-allow-credentials"]).toBe(
      "true",
    );
    expect(allowedPreflight.headers["access-control-allow-methods"]).toContain(
      "POST",
    );
    expect(allowedPreflight.headers["access-control-allow-headers"]).toContain(
      "X-CSRF-Token",
    );

    const rejectedPreflight = await app.inject({
      method: "OPTIONS",
      url: "/resource",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "POST",
      },
    });

    expect(rejectedPreflight.statusCode).toBe(204);
    expect(
      rejectedPreflight.headers["access-control-allow-origin"],
    ).toBeUndefined();
  });

  it("serves real HTTP responses with CORS headers only for allowed origins", async () => {
    const app = createServer();
    app.get("/resource", async () => ({ status: "ok" }));
    const address = await app.listen({
      host: "127.0.0.1",
      port: 0,
    });

    const allowedResponse = await fetch(`${address}/resource`, {
      headers: { origin: allowedOrigins[0] },
    });
    expect(allowedResponse.status).toBe(200);
    expect(
      allowedResponse.headers.get("access-control-allow-origin"),
    ).toBe(allowedOrigins[0]);

    const rejectedResponse = await fetch(`${address}/resource`, {
      headers: { origin: "https://untrusted.example" },
    });
    expect(rejectedResponse.status).toBe(200);
    expect(
      rejectedResponse.headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  it("generates CSRF tokens, accepts valid tokens, and rejects invalid requests", async () => {
    const app = createServer();

    app.get("/csrf-token", async (_request, reply) => ({
      token: generateCsrfToken(reply),
    }));

    app.post(
      "/protected",
      { onRequest: createCsrfProtectionHook(app) },
      async () => ({ status: "accepted" }),
    );

    const missingTokenResponse = await app.inject({
      method: "POST",
      url: "/protected",
    });
    expect(missingTokenResponse.statusCode).toBe(403);

    const tokenResponse = await app.inject({
      method: "GET",
      url: "/csrf-token",
    });
    const token = tokenResponse.json<{ token: string }>().token;
    const setCookie = tokenResponse.headers["set-cookie"];
    const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookieHeader = cookieValue?.split(";")[0];

    expect(token).toBeTruthy();
    expect(cookieHeader).toMatch(/^_csrf=/);
    expect(cookieValue).toMatch(/HttpOnly/i);

    const invalidTokenResponse = await app.inject({
      method: "POST",
      url: "/protected",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": "invalid-token",
      },
    });
    expect(invalidTokenResponse.statusCode).toBe(403);

    const validTokenResponse = await app.inject({
      method: "POST",
      url: "/protected",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": token,
      },
    });
    expect(validTokenResponse.statusCode).toBe(200);
    expect(validTokenResponse.json()).toEqual({ status: "accepted" });
  });

  it("sets the CSRF cookie Secure only in production", async () => {
    expect(getHttpCookieOptions("development").secure).toBe(false);
    expect(getHttpCookieOptions("production").secure).toBe(true);

    const app = createServer({
      allowedOrigins: ["https://example.com"],
      environment: "production",
    });
    app.get("/csrf-token", async (_request, reply) => ({
      token: generateCsrfToken(reply),
    }));

    const response = await app.inject({
      method: "GET",
      url: "/csrf-token",
    });

    expect(response.headers["set-cookie"]).toMatch(/; Secure/i);
    expect(response.headers["set-cookie"]).toMatch(/SameSite=Lax/i);
  });

  it("applies rate limits configured on individual routes", async () => {
    const app = createServer();

    app.get(
      "/limited",
      {
        config: {
          rateLimit: {
            max: 1,
            timeWindow: 60_000,
          },
        },
      },
      async () => ({ status: "ok" }),
    );

    expect((await app.inject("/limited")).statusCode).toBe(200);

    const limitedResponse = await app.inject("/limited");
    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.headers["retry-after"]).toBeDefined();
  });
});
