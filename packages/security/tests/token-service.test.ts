
import {
  describe,
  expect,
  it,
} from "vitest";

import { createTokenService } from "../src/token-service.js";

const options = {
  secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
  issuer: "sethi-backend",
  audience: "sethi-backend-api",
  accessTokenTtlSeconds: 900,
};

describe("Token Service", () => {
  it("should create and verify an access token", async () => {
    const tokens = createTokenService(options);

    const token = await tokens.createAccessToken("user-123");
    const result = await tokens.verifyAccessToken(token);

    expect(token.split(".")).toHaveLength(3);
    expect(result?.subject).toBe("user-123");
    expect(result?.expiresAt).toBeGreaterThan(result!.issuedAt);
  });

  it("should include a session identifier in session-aware access tokens", async () => {
    const tokens = createTokenService(options);
    const token = await tokens.createAccessToken("user-123", "session-456");

    await expect(tokens.verifyAccessToken(token)).resolves.toMatchObject({
      subject: "user-123",
      sessionId: "session-456",
    });
  });

  it("should reject a token signed by another secret", async () => {
    const first = createTokenService(options);

    const second = createTokenService({
      ...options,
      secret: "abcdef0123456789abcdef0123456789abcdef0123456789",
    });

    const token = await first.createAccessToken("user-123");

    expect(await second.verifyAccessToken(token)).toBeNull();
  });

  it("should reject tokens with a different audience", async () => {
    const first = createTokenService(options);

    const second = createTokenService({
      ...options,
      audience: "another-api",
    });

    const token = await first.createAccessToken("user-123");

    expect(await second.verifyAccessToken(token)).toBeNull();
  });

  it("should reject empty user IDs", async () => {
    const tokens = createTokenService(options);

    await expect(
      tokens.createAccessToken(""),
    ).rejects.toThrow("User ID is required.");
  });

  it("should reject weak JWT secrets", () => {
    expect(() =>
      createTokenService({
        ...options,
        secret: "too-short",
      }),
    ).toThrow("JWT secret must contain at least 32 bytes.");
  });

  it("should generate unique refresh tokens", () => {
    const tokens = createTokenService(options);

    const first = tokens.createRefreshToken();
    const second = tokens.createRefreshToken();

    expect(first).not.toBe(second);
    expect(first).not.toContain(".");
  });

  it("should hash refresh tokens consistently", () => {
    const tokens = createTokenService(options);
    const refreshToken = tokens.createRefreshToken();

    const firstHash = tokens.hashRefreshToken(refreshToken);
    const secondHash = tokens.hashRefreshToken(refreshToken);

    expect(firstHash).toBe(secondHash);
    expect(firstHash).not.toBe(refreshToken);
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
