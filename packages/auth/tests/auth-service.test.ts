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
  DuplicateUserError,
  InvalidRefreshTokenError,
  InvalidCredentialsError,
  type AuthUserRecord,
  type AuthUserRepository,
  type CreateAuthUserInput,
} from "../src/index.js";

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
  const sessionsById = new Map<string, {
    id: string;
    userId: string;
    refreshTokenHash: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
  }>();
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
        revokedAt: null,
      };
      sessionsById.set(session.id, session);
      return session;
    }),
    findById: vi.fn(async (id: string) => sessionsById.get(id) ?? null),
    findByRefreshTokenHash: vi.fn(async (hash: string) =>
      [...sessionsById.values()].find((session) =>
        session.refreshTokenHash === hash
      ) ?? null,
    ),
    rotateRefreshToken: vi.fn(async (input: {
      id: string;
      currentRefreshTokenHash: string;
      newRefreshTokenHash: string;
      updatedAt: Date;
    }) => {
      const session = sessionsById.get(input.id);
      if (!session || session.refreshTokenHash !== input.currentRefreshTokenHash) {
        return null;
      }

      session.refreshTokenHash = input.newRefreshTokenHash;
      session.updatedAt = input.updatedAt;
      return session;
    }),
    revokeById: vi.fn(async (id: string, _userId: string, revokedAt: Date) => {
      const session = sessionsById.get(id);
      if (!session) {
        return false;
      }
      session.revokedAt = revokedAt;
      return true;
    }),
    revokeByRefreshTokenHash: vi.fn(async () => true),
    revokeAllForUser: vi.fn(async () => undefined),
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
    createService: () =>
      createAuthService({
        users,
        sessions,
        passwordHasher,
        tokens,
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

  it("rotates refresh tokens and rejects replay of the old token", async () => {
    const service = await harness.createService();
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
  });
});
