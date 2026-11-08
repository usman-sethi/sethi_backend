import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createAuthenticationGuard,
  UnauthorizedError,
  type AuthUserRecord,
  type AuthUserRepository,
} from "../src/index.js";

const user: AuthUserRecord = {
  id: "user-123",
  email: "user@example.com",
  passwordHash: "never-return-this",
  emailVerified: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function createGuard() {
  const session = {
    id: "session-1",
    userId: user.id,
    refreshTokenHash: "refresh-hash",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  };
  const sessions = {
    ensureIndexes: vi.fn(async () => undefined),
    create: vi.fn(),
    findById: vi.fn(async (id: string) => id === session.id ? session : null),
    findByRefreshTokenHash: vi.fn(async () => null),
    rotateRefreshToken: vi.fn(),
    revokeById: vi.fn(),
    revokeByRefreshTokenHash: vi.fn(),
    revokeAllForUser: vi.fn(),
  };
  const users: AuthUserRepository = {
    ensureIndexes: vi.fn(async () => undefined),
    findByEmail: vi.fn(async () => null),
    findById: vi.fn(async (id) => id === user.id ? user : null),
    create: vi.fn(),
  };
  const tokens = {
    createAccessToken: vi.fn(async () => "unused"),
    verifyAccessToken: vi.fn(async (token: string) =>
      token === "valid"
        ? {
          subject: user.id,
          sessionId: session.id,
          issuedAt: 1,
          expiresAt: 2,
        }
        : null,
    ),
    createRefreshToken: vi.fn(() => "unused"),
    hashRefreshToken: vi.fn(() => "unused"),
  };
  const securityEvents: Array<Record<string, unknown>> = [];

  return {
    users,
    sessions,
    tokens,
    securityEvents,
    guard: createAuthenticationGuard({
      users,
      sessions,
      tokens,
      securityEventLogger: (event) => {
        securityEvents.push(event);
      },
    }),
  };
}

describe("Authentication guard", () => {
  it("authenticates a valid bearer token and strips the password hash", async () => {
    const { guard, users } = createGuard();
    const result = await guard.authenticate("Bearer valid");

    expect(users.findById).toHaveBeenCalledWith(user.id);
    expect(result).toMatchObject({
      id: user.id,
      email: user.email,
    });
    expect(result).not.toHaveProperty("passwordHash");
  });

  it.each([
    undefined,
    "",
    "Basic valid",
    "Bearer",
    "Bearer token with spaces",
  ])("rejects malformed or missing Authorization: %s", async (header) => {
    const { guard, tokens } = createGuard();

    await expect(guard.authenticate(header)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(tokens.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("rejects an invalid or expired token", async () => {
    const { guard } = createGuard();

    await expect(
      guard.authenticate("Bearer invalid"),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects tokens whose subject no longer exists", async () => {
    const { guard, tokens } = createGuard();
    tokens.verifyAccessToken.mockResolvedValue({
      subject: "missing",
      issuedAt: 1,
      expiresAt: 2,
    });

    await expect(
      guard.authenticate("Bearer valid"),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects legacy tokens without a session and revoked or expired sessions", async () => {
    const legacy = createGuard();
    legacy.tokens.verifyAccessToken.mockResolvedValue({
      subject: user.id,
      issuedAt: 1,
      expiresAt: 2,
    });
    await expect(legacy.guard.authenticate("Bearer valid")).rejects
      .toBeInstanceOf(UnauthorizedError);
    expect(legacy.sessions.findById).not.toHaveBeenCalled();

    const revoked = createGuard();
    revoked.sessions.findById.mockResolvedValue({
      id: "session-1",
      userId: user.id,
      refreshTokenHash: "hash",
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date(),
    });
    await expect(revoked.guard.authenticate("Bearer valid")).rejects
      .toBeInstanceOf(UnauthorizedError);

    const expired = createGuard();
    expired.sessions.findById.mockResolvedValue({
      id: "session-1",
      userId: user.id,
      refreshTokenHash: "hash",
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() - 1),
      revokedAt: null,
    });
    await expect(expired.guard.authenticate("Bearer valid")).rejects
      .toBeInstanceOf(UnauthorizedError);

    const wrongOwner = createGuard();
    wrongOwner.sessions.findById.mockResolvedValue({
      id: "session-1",
      userId: "another-user",
      refreshTokenHash: "hash",
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    await expect(wrongOwner.guard.authenticate("Bearer valid")).rejects
      .toBeInstanceOf(UnauthorizedError);
    expect(wrongOwner.securityEvents).toContainEqual(
      expect.objectContaining({
        type: "access.rejected",
        reason: "session_mismatch",
      }),
    );
    expect(JSON.stringify(wrongOwner.securityEvents)).not.toContain("valid");
  });
});
