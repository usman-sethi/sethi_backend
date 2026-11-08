export interface AuthUserRecord {
  id: string;
  email: string;
  passwordHash: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type PublicAuthUser = Omit<AuthUserRecord, "passwordHash">;

export interface CreateAuthUserInput {
  email: string;
  passwordHash: string;
  emailVerified: false;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthUserRepository {
  ensureIndexes(): Promise<void>;
  findByEmail(email: string): Promise<AuthUserRecord | null>;
  findById(id: string): Promise<AuthUserRecord | null>;
  create(input: CreateAuthUserInput): Promise<AuthUserRecord>;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  refreshTokenHash: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  rotationCount?: number;
}

export interface AuthRefreshTokenLookup {
  session: AuthSessionRecord;
  status: "current" | "consumed";
}

export type RotateAuthSessionResult =
  | { status: "rotated"; session: AuthSessionRecord }
  | { status: "replayed"; session: AuthSessionRecord }
  | { status: "rotation_limit"; session: AuthSessionRecord }
  | { status: "invalid" };

export interface CreateAuthSessionInput {
  userId: string;
  refreshTokenHash: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface RotateAuthSessionInput {
  id: string;
  userId: string;
  currentRefreshTokenHash: string;
  newRefreshTokenHash: string;
  updatedAt: Date;
}

export interface AuthSessionRepository {
  ensureIndexes(): Promise<void>;
  create(input: CreateAuthSessionInput): Promise<AuthSessionRecord>;
  findById(id: string): Promise<AuthSessionRecord | null>;
  findByRefreshTokenHash(
    hash: string,
  ): Promise<AuthRefreshTokenLookup | null>;
  rotateRefreshToken(
    input: RotateAuthSessionInput,
  ): Promise<RotateAuthSessionResult>;
  revokeById(id: string, userId: string, revokedAt: Date): Promise<boolean>;
  revokeByRefreshTokenHash(hash: string, revokedAt: Date): Promise<boolean>;
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>;
}

export interface AuthenticationResult {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: PublicAuthUser;
}

export interface AuthService {
  register(input: unknown): Promise<AuthenticationResult>;
  login(input: unknown): Promise<AuthenticationResult>;
  refresh(refreshToken: string): Promise<AuthenticationResult>;
  logout(refreshToken: string | undefined): Promise<void>;
  logoutAll(userId: string): Promise<void>;
}

export type AuthSecurityEvent =
  | {
    type: "refresh.succeeded";
    userId: string;
    sessionId: string;
  }
  | {
    type: "refresh.rejected";
    reason: "invalid" | "expired" | "revoked" | "rotation_limit";
    userId?: string;
    sessionId?: string;
  }
  | {
    type: "refresh.replay_detected";
    userId: string;
    sessionId: string;
  }
  | {
    type: "session.revoked";
    sessionId: string;
  }
  | {
    type: "sessions.revoked_all";
    userId: string;
  }
  | {
    type: "access.rejected";
    reason:
      | "invalid"
      | "session_missing"
      | "session_mismatch"
      | "session_revoked"
      | "session_expired"
      | "user_missing";
    userId?: string;
    sessionId?: string;
  };

export type AuthSecurityEventLogger = (event: AuthSecurityEvent) => void;

export interface AuthenticationGuard {
  authenticate(authorizationHeader: string | undefined): Promise<PublicAuthUser>;
}
