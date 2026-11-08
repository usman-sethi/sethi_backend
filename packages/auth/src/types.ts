export const USER_ROLES = ["user", "moderator", "admin"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const PERMISSIONS = [
  "profile:read",
  "profile:update",
  "users:read",
  "users:manage",
  "sessions:revoke",
  "roles:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  user: ["profile:read", "profile:update"],
  moderator: [
    "profile:read",
    "profile:update",
    "users:read",
    "users:manage",
    "sessions:revoke",
  ],
  admin: PERMISSIONS,
};

export interface AuthUserRecord {
  id: string;
  email: string;
  passwordHash: string;
  emailVerified: boolean;
  emailVerifiedAt: Date | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export type PublicAuthUser = Omit<AuthUserRecord, "passwordHash">;

export interface CreateAuthUserInput {
  email: string;
  passwordHash: string;
  emailVerified: false;
  emailVerifiedAt: null;
  role: "user";
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthUserRepository {
  ensureIndexes(): Promise<void>;
  findByEmail(email: string): Promise<AuthUserRecord | null>;
  findById(id: string): Promise<AuthUserRecord | null>;
  create(input: CreateAuthUserInput): Promise<AuthUserRecord>;
  list(): Promise<PublicAuthUser[]>;
  setRole(
    userId: string,
    role: UserRole,
    updatedAt: Date,
    actorUserId: string | null,
  ): Promise<SetUserRoleResult>;
}

export type SetUserRoleResult =
  | {
    status: "updated";
    user: PublicAuthUser;
    previousRole: UserRole;
  }
  | { status: "unchanged" }
  | { status: "not_found" }
  | { status: "last_admin" }
  | { status: "actor_not_admin" }
  | { status: "email_unverified" };

export type AuthActionTokenPurpose = "email-verification" | "password-reset";

export interface AuthActionTokenRecord {
  userId: string;
  tokenHash: string;
  purpose: AuthActionTokenPurpose;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export type ReplaceAuthActionTokenInput = AuthActionTokenRecord;

export interface ResetPasswordInput {
  tokenHash: string;
  passwordHash: string;
  now: Date;
}

export interface AuthActionTokenRepository {
  ensureIndexes(): Promise<void>;
  replaceForUser(input: ReplaceAuthActionTokenInput): Promise<void>;
  findByHash(hash: string): Promise<AuthActionTokenRecord | null>;
  verifyEmail(tokenHash: string, now: Date): Promise<boolean>;
  resetPassword(input: ResetPasswordInput): Promise<boolean>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
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
  register(input: unknown): Promise<void>;
  login(input: unknown): Promise<AuthenticationResult>;
  refresh(refreshToken: string): Promise<AuthenticationResult>;
  logout(refreshToken: string | undefined): Promise<void>;
  logoutAll(userId: string): Promise<void>;
  changeUserRole(
    targetUserId: string,
    role: UserRole,
    actorUserId: string,
  ): Promise<void>;
  verifyEmail(input: unknown): Promise<void>;
  resendVerification(input: unknown): Promise<void>;
  requestPasswordReset(input: unknown): Promise<void>;
  resetPassword(input: unknown): Promise<void>;
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
    type: "email.delivery_failed";
    purpose: AuthActionTokenPurpose | "password-changed";
    userId: string;
  }
  | {
    type: "user.role_changed";
    actorUserId: string;
    targetUserId: string;
    previousRole: UserRole;
    role: UserRole;
  }
  | {
    type: "access.rejected";
    reason:
      | "invalid"
      | "session_missing"
      | "session_mismatch"
      | "session_revoked"
      | "session_expired"
      | "user_missing"
      | "email_unverified";
    userId?: string;
    sessionId?: string;
  };

export type AuthSecurityEventLogger = (event: AuthSecurityEvent) => void;

export interface AuthenticationGuard {
  authenticate(authorizationHeader: string | undefined): Promise<PublicAuthUser>;
}

export function roleHasPermission(
  role: UserRole,
  permission: Permission,
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
