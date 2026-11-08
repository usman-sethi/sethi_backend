export {
  createAuthService,
  DEFAULT_AUTH_SESSION_TTL_SECONDS,
} from "./auth-service.js";
export type { CreateAuthServiceOptions } from "./auth-service.js";
export { createAuthenticationGuard } from "./authentication-guard.js";
export type { CreateAuthenticationGuardOptions } from "./authentication-guard.js";
export {
  AuthError,
  AuthRepositoryError,
  AuthValidationError,
  DuplicateUserError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  UnauthorizedError,
  UserNotFoundError,
} from "./errors.js";
export {
  loginSchema,
  registrationSchema,
} from "./schemas.js";
export type {
  LoginInput,
  RegistrationInput,
} from "./schemas.js";
export type {
  AuthService,
  AuthSessionRecord,
  AuthSessionRepository,
  AuthUserRecord,
  AuthUserRepository,
  AuthenticationGuard,
  AuthenticationResult,
  CreateAuthUserInput,
  PublicAuthUser,
  CreateAuthSessionInput,
  RotateAuthSessionInput,
} from "./types.js";
