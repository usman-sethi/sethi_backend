export {
  createAuthService,
  DEFAULT_AUTH_SESSION_TTL_SECONDS,
  DEFAULT_EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
  DEFAULT_PASSWORD_RESET_TOKEN_TTL_SECONDS,
} from "./auth-service.js";
export type { CreateAuthServiceOptions } from "./auth-service.js";
export { createAuthenticationGuard } from "./authentication-guard.js";
export type { CreateAuthenticationGuardOptions } from "./authentication-guard.js";
export {
  requirePermission,
  requireRole,
} from "./authorization.js";
export {
  AuthError,
  AuthRepositoryError,
  AuthValidationError,
  DuplicateUserError,
  ForbiddenError,
  InvalidCredentialsError,
  InvalidActionTokenError,
  InvalidRefreshTokenError,
  LastAdministratorError,
  UnauthorizedError,
  UnverifiedUserError,
  UserNotFoundError,
} from "./errors.js";
export {
  emailInputSchema,
  loginSchema,
  passwordResetSchema,
  registrationSchema,
  verificationTokenSchema,
} from "./schemas.js";
export type {
  EmailInput,
  LoginInput,
  PasswordResetInput,
  RegistrationInput,
} from "./schemas.js";
export type {
  AuthActionTokenPurpose,
  AuthActionTokenRecord,
  AuthActionTokenRepository,
  AuthService,
  AuthRefreshTokenLookup,
  AuthSecurityEvent,
  AuthSecurityEventLogger,
  AuthSessionRecord,
  AuthSessionRepository,
  AuthUserRecord,
  AuthUserRepository,
  AuthenticationGuard,
  AuthenticationResult,
  EmailMessage,
  EmailSender,
  Permission,
  ReplaceAuthActionTokenInput,
  ResetPasswordInput,
  SetUserRoleResult,
  UserRole,
  CreateAuthUserInput,
  PublicAuthUser,
  CreateAuthSessionInput,
  RotateAuthSessionResult,
  RotateAuthSessionInput,
} from "./types.js";
export {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  USER_ROLES,
  roleHasPermission,
} from "./types.js";
