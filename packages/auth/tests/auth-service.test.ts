import { createHash } from "node:crypto";
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
  ForbiddenError,
  InvalidRefreshTokenError,
  InvalidActionTokenError,
  InvalidCredentialsError,
  roleHasPermission,
  requireRole,
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
    list: vi.fn(async () => [...usersById.values()].map(({ passwordHash: _hash, ...user }) => user)),
    setRole: vi.fn(async (userId, role, _updatedAt, actorUserId) => {
      if (actorUserId === userId) {
        return { status: "actor_not_admin" as const };
      }
      const user = usersById.get(userId);
      if (!user) {
        return { status: "not_found" as const };
      }
      const previousRole = user.role;
      user.role = role;
      return {
        status: "updated" as const,
        user: (({ passwordHash: _hash, ...publicUser }) => publicUser)(user),
        previousRole,
      };
    }),
  };
  const actionRecords = new Map<string, {
    userId: string;
    tokenHash: string;
    purpose: "email-verification" | "password-reset";
    expiresAt: Date;
    consumedAt: Date | null;
    createdAt: Date;
  }>();
  const actionTokens = {
    ensureIndexes: vi.fn(async () => undefined),
    replaceForUser: vi.fn(async (input: {
      userId: string;
      tokenHash: string;
      purpose: "email-verification" | "password-reset";
      expiresAt: Date;
      consumedAt: Date | null;
      createdAt: Date;
    }) => {
      actionRecords.set(`${input.userId}:${input.purpose}`, input);
    }),
    findByHash: vi.fn(async (hash: string) =>
      [...actionRecords.values()].find((record) => record.tokenHash === hash) ?? null
    ),
    verifyEmail: vi.fn(async (tokenHash: string, now: Date) => {
      const record = [...actionRecords.values()].find((item) =>
        item.tokenHash === tokenHash &&
        item.purpose === "email-verification" &&
        item.consumedAt === null &&
        item.expiresAt > now
      );
      if (!record) {
        return false;
      }
      record.consumedAt = now;
      const user = usersById.get(record.userId);
      if (!user || user.emailVerified) {
        return false;
      }
      user.emailVerified = true;
      user.emailVerifiedAt = now;
      return true;
    }),
    resetPassword: vi.fn(async (input: {
      tokenHash: string;
      passwordHash: string;
      now: Date;
    }) => {
      const record = [...actionRecords.values()].find((item) =>
        item.tokenHash === input.tokenHash &&
        item.purpose === "password-reset" &&
        item.consumedAt === null &&
        item.expiresAt > input.now
      );
      if (!record) {
        return false;
      }
      const user = usersById.get(record.userId);
      if (!user) {
        return false;
      }
      record.consumedAt = input.now;
      user.passwordHash = input.passwordHash;
      for (const session of sessionsById.values()) {
        if (session.userId === user.id) {
          session.revokedAt = input.now;
        }
      }
      return true;
    }),
  };
  const emailMessages: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const emailSender = {
    send: vi.fn(async (message: typeof emailMessages[number]) => {
      emailMessages.push(message);
    }),
  };

  return {
    users,
    actionTokens,
    emailMessages,
    emailSender,
    actionRecords,
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
        actionTokens,
        passwordHasher,
        tokens,
        emailSender,
        appBaseUrl: "https://frontend.example",
        securityEventLogger,
      }),
  };
}

function getEmailToken(harness: ReturnType<typeof createHarness>, index = -1): string {
  const email = harness.emailMessages.at(index);
  const link = email?.html.match(/href="([^"]+)"/)?.[1];
  if (!link) {
    throw new Error("Expected an email action link.");
  }
  const token = new URL(link).hash.slice(1);
  const parsed = new URLSearchParams(token).get("token");
  if (!parsed) {
    throw new Error("Expected an action token in the URL fragment.");
  }
  return parsed;
}

function createHashForToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function verifyUser(
  service: Awaited<ReturnType<ReturnType<typeof createHarness>["createService"]>>,
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  await service.verifyEmail({ token: getEmailToken(harness) });
}

async function registerVerifiedUser(
  service: Awaited<ReturnType<ReturnType<typeof createHarness>["createService"]>>,
  harness: ReturnType<typeof createHarness>,
  email = "user@example.com",
  password = "a secure passphrase 123",
): Promise<void> {
  await service.register({ email, password });
  await verifyUser(service, harness);
}

async function registerAndLogin(
  service: Awaited<ReturnType<ReturnType<typeof createHarness>["createService"]>>,
  harness: ReturnType<typeof createHarness>,
  email = "user@example.com",
  password = "a secure passphrase 123",
): Promise<void> {
  await registerVerifiedUser(service, harness, email, password);
  await service.login({ email, password });
}

describe("Authentication service", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it("normalizes email, hashes password and issues a verification email without creating a session", async () => {
    const service = await harness.createService();
    await service.register({
      email: "  User@Example.COM ",
      password: "a secure passphrase 123",
    });

    expect(harness.users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        passwordHash: "hash:a secure passphrase 123",
        emailVerified: false,
        emailVerifiedAt: null,
        role: "user",
      }),
    );
    expect(harness.sessions.create).not.toHaveBeenCalled();
    expect(harness.emailMessages[0]).toMatchObject({
      to: "user@example.com",
      subject: "Verify your email address",
    });
    const token = getEmailToken(harness);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await harness.actionTokens.findByHash(
      createHashForToken(token),
    )).toMatchObject({ purpose: "email-verification" });
    await service.verifyEmail({ token });
    expect(harness.usersByEmail.get("user@example.com")).toMatchObject({
      emailVerified: true,
      emailVerifiedAt: expect.any(Date),
    });
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

  it("returns a generic result for duplicate normalized registrations", async () => {
    const service = await harness.createService();
    await service.register({
      email: "user@example.com",
      password: "a secure passphrase 123",
    });

    await expect(service.register({
      email: "USER@example.com",
      password: "another secure passphrase 456",
    })).resolves.toBeUndefined();
    expect(harness.usersByEmail.size).toBe(1);
  });

  it("logs in with normalized email and valid password", async () => {
    const service = await harness.createService();
    await registerVerifiedUser(service, harness);

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
    await registerVerifiedUser(service, harness);

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

  it("creates a persistent session only after email verification and login", async () => {
    const service = await harness.createService();
    await expect(service.login({
      email: "user@example.com",
      password: "a secure passphrase 123",
    })).rejects.toBeInstanceOf(InvalidCredentialsError);
    await registerAndLogin(service, harness);

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
    expect(harness.usersByEmail.get("user@example.com")?.emailVerified).toBe(true);
  });

  it("rotates refresh tokens and revokes the session when an old token is replayed", async () => {
    const securityEvents: Array<{ type: string; sessionId?: string }> = [];
    const service = await harness.createService((event) => {
      securityEvents.push(event);
    });
    await registerAndLogin(service, harness);
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
    await registerAndLogin(service, harness);
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
    await registerAndLogin(service, harness);
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
    await registerAndLogin(service, harness);
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
    await registerAndLogin(service, harness);
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
    await registerAndLogin(service, harness);
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
    await registerVerifiedUser(service, harness);
    harness.tokens.createAccessToken.mockRejectedValueOnce(
      new Error("signing failed"),
    );

    await expect(service.login({
      email: "user@example.com",
      password: "a secure passphrase 123",
    })).rejects.toThrow("signing failed");
    expect(harness.sessionsById.get("session-1")?.revokedAt)
      .toBeInstanceOf(Date);
  });

  it("rejects unknown, expired and reused email-verification tokens", async () => {
    const service = await harness.createService();
    await expect(service.verifyEmail({ token: "unknown-token" }))
      .rejects.toBeInstanceOf(InvalidActionTokenError);

    await service.register({
      email: "expired@example.com",
      password: "a secure passphrase 123",
    });
    const expiredRecord = harness.actionRecords.get("user-1:email-verification");
    if (!expiredRecord) {
      throw new Error("Expected an issued email-verification token.");
    }
    const expiredToken = getEmailToken(harness);
    expiredRecord.expiresAt = new Date(Date.now() - 1);
    await expect(service.verifyEmail({ token: expiredToken }))
      .rejects.toBeInstanceOf(InvalidActionTokenError);

    await service.resendVerification({ email: "EXPIRED@example.com" });
    const currentToken = getEmailToken(harness);
    await service.verifyEmail({ token: currentToken });
    await expect(service.verifyEmail({ token: currentToken }))
      .rejects.toBeInstanceOf(InvalidActionTokenError);
  });

  it("resends a fresh token and treats unknown or already-verified accounts generically", async () => {
    const service = await harness.createService();
    await service.register({
      email: "resend@example.com",
      password: "a secure passphrase 123",
    });
    const oldToken = getEmailToken(harness);
    await service.resendVerification({ email: " RESEND@example.com " });
    const newToken = getEmailToken(harness);
    expect(newToken).not.toBe(oldToken);
    await expect(service.verifyEmail({ token: oldToken }))
      .rejects.toBeInstanceOf(InvalidActionTokenError);
    await service.verifyEmail({ token: newToken });
    const emailCount = harness.emailMessages.length;
    await service.resendVerification({ email: "missing@example.com" });
    await service.resendVerification({ email: "resend@example.com" });
    expect(harness.emailMessages).toHaveLength(emailCount);
  });

  it("keeps a registration and retryable token when email delivery fails", async () => {
    const service = await harness.createService();
    harness.emailSender.send.mockRejectedValueOnce(
      new Error("SMTP password must not be exposed"),
    );
    await expect(service.register({
      email: "retry@example.com",
      password: "a secure passphrase 123",
    })).resolves.toBeUndefined();
    expect(harness.actionRecords.has("user-1:email-verification")).toBe(true);

    await service.resendVerification({ email: "retry@example.com" });
    expect(harness.emailMessages.at(-1)?.to).toBe("retry@example.com");
    expect(harness.usersByEmail.get("retry@example.com")?.emailVerified).toBe(false);
  });

  it("resets passwords once and revokes existing sessions", async () => {
    const service = await harness.createService();
    await registerAndLogin(service, harness);
    await service.requestPasswordReset({ email: " USER@example.com " });
    const token = getEmailToken(harness);

    await service.resetPassword({
      token,
      newPassword: "a brand new secure passphrase 456",
    });
    expect(harness.usersByEmail.get("user@example.com")?.passwordHash)
      .toBe("hash:a brand new secure passphrase 456");
    expect(harness.sessionsById.get("session-1")?.revokedAt)
      .toBeInstanceOf(Date);
    await expect(service.resetPassword({
      token,
      newPassword: "another strong password 789",
    })).rejects.toBeInstanceOf(InvalidActionTokenError);
    await expect(service.login({
      email: "user@example.com",
      password: "a secure passphrase 123",
    })).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(service.login({
      email: "user@example.com",
      password: "a brand new secure passphrase 456",
    })).resolves.toMatchObject({
      user: { email: "user@example.com" },
    });
  });

  it("allows only one concurrent reset-token consumption", async () => {
    const service = await harness.createService();
    await registerVerifiedUser(service, harness);
    await service.requestPasswordReset({ email: "user@example.com" });
    const token = getEmailToken(harness);
    const reset = () => service.resetPassword({
      token,
      newPassword: "a concurrent safe new password 456",
    });
    const results = await Promise.allSettled([reset(), reset()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("invalidates old reset tokens and explicitly rejects expired tokens", async () => {
    const service = await harness.createService();
    await registerVerifiedUser(service, harness);
    await service.requestPasswordReset({ email: "user@example.com" });
    const firstToken = getEmailToken(harness);
    await service.requestPasswordReset({ email: "user@example.com" });
    const currentToken = getEmailToken(harness);

    await expect(service.resetPassword({
      token: firstToken,
      newPassword: "a valid new password 456",
    })).rejects.toBeInstanceOf(InvalidActionTokenError);

    const record = harness.actionRecords.get("user-1:password-reset");
    if (!record) {
      throw new Error("Expected an issued password-reset token.");
    }
    record.expiresAt = new Date(Date.now() - 1);
    await expect(service.resetPassword({
      token: currentToken,
      newPassword: "another valid new password 789",
    })).rejects.toBeInstanceOf(InvalidActionTokenError);
  });

  it("assigns the user role server-side and resolves permissions centrally", async () => {
    const service = await harness.createService();
    await service.register({
      email: "role@example.com",
      password: "a secure passphrase 123",
    });
    expect(harness.usersByEmail.get("role@example.com")?.role).toBe("user");
    expect(roleHasPermission("moderator", "users:read")).toBe(true);
    expect(roleHasPermission("moderator", "roles:manage")).toBe(false);
    expect(roleHasPermission("admin", "roles:manage")).toBe(true);
    expect(() => requireRole({ role: "user" }, "admin"))
      .toThrow(ForbiddenError);

    await expect(service.changeUserRole("user-1", "admin", "user-1"))
      .rejects.toBeInstanceOf(ForbiddenError);
  });
});
