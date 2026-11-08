import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createAuthService,
  AuthValidationError,
  AuthRepositoryError,
  DuplicateUserError,
  InvalidRefreshTokenError,
  InvalidCredentialsError,
  type AuthUserRecord,
  type AuthSessionRecord,
  type AuthUserRepository,
  type CreateAuthUserInput,
} from "../src/index.js";

type MockSessionRecord = AuthSessionRecord & {
  consumedRefreshTokenHashes: string[];
};

function createHarness() {
  const usersByEmail = new Map<string, AuthUserRecord>();
  const usersById = new Map<string, AuthUserRecord>();
  let nextId = 0;
  const verify = vi.fn(async (password: string, hash: string) =>
    hash === `hash:${password}`,
  );
  const passwordHasher = {
    hash: vi.fn(async (password: string) => `hash:${password}`),
    verify,
  };
  const tokens = {
    createAccessToken: vi.fn(async (userId: string) => `access:${userId}`),
    verifyAccessToken: vi.fn(async () => null),
    createRefreshToken: vi.fn(() => "refresh-token"),
    hashRefreshToken: vi.fn((token: string) => `hash:${token}`),
  };
  const sessionsById = new Map<string, MockSessionRecord>();
  const sessions = {
    ensureIndexes: vi.fn(async () => undefined),
    create: vi.fn(async (input: {
      userId: string;
      refreshTokenHash: string;
      createdAt: Date;
      updatedAt: Date;
      expiresAt: Date;
    }) => {
      const session = {
        id: "session-1",
        ...input,
        consumedRefreshTokenHashes: [],
        revokedAt: null,
      };
      sessionsById.set(session.id, session);
      return session;
    }),
    findById: vi.fn(async (id: string) => sessionsById.get(id) ?? null),
    findByRefreshTokenHash: vi.fn(async (hash: string) => {
      const current = [...sessionsById.values()].find((session) =>
        session.refreshTokenHash === hash
      );
      if (current) {
        return { session: current, status: "current" as const };
      }

      const consumed = [...sessionsById.values()].find((session) =>
        session.consumedRefreshTokenHashes.includes(hash)
      );
      return consumed
        ? { session: consumed, status: "consumed" as const }
        : null;
    }),
    rotateRefreshToken: vi.fn(async (input: {
      id: string;
      currentRefreshTokenHash: string;
      newRefreshTokenHash: string;
      updatedAt: Date;
    }) => {
      const session = sessionsById.get(input.id);
      if (!session || session.revokedAt || session.expiresAt <= input.updatedAt) {
        return { status: "invalid" as const };
      }

      if (session.refreshTokenHash !== input.currentRefreshTokenHash) {
        if (
          session.consumedRefreshTokenHashes.includes(
            input.currentRefreshTokenHash,
          )
        ) {
          session.revokedAt = input.updatedAt;
          session.updatedAt = input.updatedAt;
          return { status: "replayed" as const, session };
        }
        return { status: "invalid" as const };
      }

      session.consumedRefreshTokenHashes.push(input.currentRefreshTokenHash);
      session.refreshTokenHash = input.newRefreshTokenHash;
      session.updatedAt = input.updatedAt;
      return { status: "rotated" as const, session };
    }),
    revokeById: vi.fn(async (id: string, userId: string, revokedAt: Date) => {
      const session = sessionsById.get(id);
      if (!session || session.userId !== userId || session.revokedAt) {
        return false;
      }
      session.revokedAt = revokedAt;
      return true;
    }),
    revokeByRefreshTokenHash: vi.fn(async (hash: string, revokedAt: Date) => {
      const session = [...sessionsById.values()].find((record) =>
        record.refreshTokenHash === hash ||
        record.consumedRefreshTokenHashes.includes(hash)
      );
      if (!session || session.revokedAt) {
        return false;
      }
      session.revokedAt = revokedAt;
      return true;
    }),
    revokeAllForUser: vi.fn(async (userId: string, revokedAt: Date) => {
      for (const session of sessionsById.values()) {
        if (session.userId === userId && !session.revokedAt) {
          session.revokedAt = revokedAt;
        }
      }
    }),
  };
  const users: AuthUserRepository = {
    ensureIndexes: vi.fn(async () => undefined),
    findByEmail: vi.fn(async (email) => usersByEmail.get(email) ?? null),
    findById: vi.fn(async (id) => usersById.get(id) ?? null),
    create: vi.fn(async (input: CreateAuthUserInput) => {
      if (usersByEmail.has(input.email)) {
        throw new DuplicateUserError();
      }

      const user: AuthUserRecord = {
        id: `user-${++nextId}`,
        ...input,
      };
      usersByEmail.set(user.email, user);
      usersById.set(user.id, user);
      return user;
    }),
  };

  return {
    users,
    usersByEmail,
    usersById,
    passwordHasher,
    tokens,
    sessions,
    sessionsById,
    createService: (securityEventLogger?: (event: {
      type: string;
      userId?: string;
      sessionId?: string;
      reason?: string;
    }) => void) =>
      createAuthService({
        users,
        sessions,
        passwordHasher,
        tokens,
        securityEventLogger,
      }),
  };
}

describe("Authentication service", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it("normalizes email, hashes password, and returns only public user data", async () => {
    const service = await harness.createService();
    const result = await service.register({
      email: "  User@Example.COM ",
      password: "a secure passphrase 123",
    });

    expect(harness.users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        passwordHash: "hash:a secure passphrase 123",
        emailVerified: false,
      }),
    );
    expect(result.accessToken).toBe("access:user-1");
    expect(result.user).toMatchObject({
      id: "user-1",
      email: "user@example.com",
      emailVerified: false,
    });
    expect(result.user).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(result)).not.toContain("hash:");
  });

  it("rejects short passwords and unexpected registration properties", async () => {
    const service = await harness.createService();

    await expect(
      service.register({
        email: "user@example.com",
        password: "short",
      }),
    ).rejects.toBeInstanceOf(AuthValidationError);

    await expect(
      service.register({
        email: "user@example.com",
        password: "a secure passphrase 123",
        role: "admin",
        passwordHash: "attacker-controlled",
      }),
    ).rejects.toBeInstanceOf(AuthValidationError);
    expect(harness.users.create).not.toHaveBeenCalled();
  });

  it("maps duplicate repository records to a predictable conflict error", async () => {
    const service = await harness.createService();
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });

    await expect(
      service.register({
        email: "USER@example.com",
        password: "another secure passphrase 456",
      }),
    ).rejects.toBeInstanceOf(DuplicateUserError);
  });

  it("logs in with normalized email and valid password", async () => {
    const service = await harness.createService();
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });

    const result = await service.login({
      email: " USER@Example.com ",
      password: "a secure passphrase 123",
    });

    expect(result.accessToken).toBe("access:user-1");
    expect(result.user.email).toBe("user@example.com");
    expect(result.user).not.toHaveProperty("passwordHash");
  });

  it("uses one startup dummy hash for unknown users and returns generic credentials errors", async () => {
    const service = await harness.createService();
    const dummyHash = harness.passwordHasher.hash.mock.results[0]?.value;
    expect(harness.passwordHasher.hash).toHaveBeenCalledTimes(1);

    await expect(
      service.login({
        email: "missing@example.com",
        password: "a secure passphrase 123",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(harness.passwordHasher.verify).toHaveBeenCalledWith(
      "a secure passphrase 123",
      await dummyHash,
    );
    expect(harness.passwordHasher.hash).toHaveBeenCalledTimes(1);
  });

  it("returns the same public error for a wrong password", async () => {
    const service = await harness.createService();
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });

    await expect(
      service.login({
        email: "user@example.com",
        password: "wrong but long enough",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("keeps passwords byte-for-byte unchanged", async () => {
    const service = await harness.createService();
    const password = "  Case-sensitive PASS phrase  ";

    await service.register({
      email: "user@example.com",
      password,
    });

    expect(harness.passwordHasher.hash).toHaveBeenLastCalledWith(password);
  });

  it("creates a persistent session and returns a refresh token for cookie transport", async () => {
    const service = await harness.createService();
    const result = await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });

    expect(harness.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        refreshTokenHash: "hash:refresh-token",
        expiresAt: expect.any(Date),
      }),
    );
    expect(harness.tokens.createAccessToken).toHaveBeenCalledWith(
      "user-1",
      "session-1",
    );
    expect(result.refreshToken).toBe("refresh-token");
  });

  it("rotates refresh tokens and revokes the session when an old token is replayed", async () => {
    const securityEvents: Array<{ type: string; sessionId?: string }> = [];
    const service = await harness.createService((event) => {
      securityEvents.push(event);
    });
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });
    harness.tokens.createRefreshToken.mockReturnValueOnce("rotated-token");

    const result = await service.refresh("refresh-token");

    expect(result.refreshToken).toBe("rotated-token");
    expect(harness.sessions.rotateRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        currentRefreshTokenHash: "hash:refresh-token",
        newRefreshTokenHash: "hash:rotated-token",
      }),
    );
    await expect(service.refresh("refresh-token")).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
    expect(harness.sessionsById.get("session-1")?.revokedAt)
      .toBeInstanceOf(Date);
    expect(securityEvents).toContainEqual(expect.objectContaining({
      type: "refresh.replay_detected",
      sessionId: "session-1",
    }));
  });

  it("detects replay after multiple rotations and records no token material", async () => {
    const securityEvents: Array<Record<string, unknown>> = [];
    const service = await harness.createService((event) => {
      securityEvents.push(event);
    });
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });
    harness.tokens.createRefreshToken
      .mockReturnValueOnce("refresh-B")
      .mockReturnValueOnce("refresh-C");

    await service.refresh("refresh-token");
    await service.refresh("refresh-B");
    await expect(service.refresh("refresh-token")).rejects
      .toBeInstanceOf(InvalidRefreshTokenError);

    expect(harness.sessionsById.get("session-1")).toMatchObject({
      refreshTokenHash: "hash:refresh-C",
      revokedAt: expect.any(Date),
    });
    expect(JSON.stringify(securityEvents)).not.toContain("refresh-token");
    expect(JSON.stringify(securityEvents)).not.toContain("hash:");
  });

  it("allows only one concurrent rotation and revokes the family on reuse", async () => {
    const service = await harness.createService();
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });
    harness.tokens.createRefreshToken
      .mockReturnValueOnce("refresh-B")
      .mockReturnValueOnce("refresh-C");

    const results = await Promise.allSettled([
      service.refresh("refresh-token"),
      service.refresh("refresh-token"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(harness.sessionsById.get("session-1")?.revokedAt)
      .toBeInstanceOf(Date);
  });

  it("fails closed when atomic rotation reports a database failure", async () => {
    const service = await harness.createService();
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });
    harness.sessions.rotateRefreshToken.mockRejectedValue(
      new Error("database write failed"),
    );

    await expect(service.refresh("refresh-token")).rejects.toBeInstanceOf(
      AuthRepositoryError,
    );
    expect(harness.sessionsById.get("session-1")?.refreshTokenHash)
      .toBe("hash:refresh-token");
  });

  it("rejects expired sessions before attempting a token rotation", async () => {
    const service = await harness.createService();
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });
    const session = harness.sessionsById.get("session-1")!;
    session.expiresAt = new Date(Date.now() - 1);

    await expect(service.refresh("refresh-token")).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
    expect(harness.sessions.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it("revokes a session at the refresh-history cap and reports a sanitized event", async () => {
    const securityEvents: Array<Record<string, unknown>> = [];
    const service = await harness.createService((event) => {
      securityEvents.push(event);
    });
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });
    const session = harness.sessionsById.get("session-1")!;
    harness.sessions.rotateRefreshToken.mockResolvedValueOnce({
      status: "rotation_limit",
      session: {
        ...session,
        revokedAt: new Date(),
      },
    });

    await expect(service.refresh("refresh-token")).rejects.toBeInstanceOf(
      InvalidRefreshTokenError,
    );
    expect(securityEvents).toContainEqual(expect.objectContaining({
      type: "refresh.rejected",
      reason: "rotation_limit",
      sessionId: "session-1",
    }));
    expect(JSON.stringify(securityEvents)).not.toContain("refresh-token");
  });

  it("revokes a newly-created session when access-token signing fails", async () => {
    const service = await harness.createService();
    harness.tokens.createAccessToken.mockRejectedValueOnce(
      new Error("signing failed"),
    );

    await expect(service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    })).rejects.toThrow("signing failed");
    expect(harness.sessionsById.get("session-1")?.revokedAt)
      .toBeInstanceOf(Date);
  });
});
