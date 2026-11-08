export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthValidationError extends AuthError {
  constructor(message = "Authentication input is invalid.") {
    super(message, "AUTH_VALIDATION");
  }
}

export class DuplicateUserError extends AuthError {
  constructor(options?: ErrorOptions) {
    super("A user with this email already exists.", "AUTH_DUPLICATE_USER", options);
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super("Invalid email or password.", "AUTH_INVALID_CREDENTIALS");
  }
}

export class InvalidRefreshTokenError extends AuthError {
  constructor() {
    super("Refresh token is invalid or expired.", "AUTH_INVALID_REFRESH_TOKEN");
  }
}

export class UnauthorizedError extends AuthError {
  constructor(message = "Authentication is required.") {
    super(message, "AUTH_UNAUTHORIZED");
  }
}

export class ForbiddenError extends AuthError {
  constructor(message = "You are not authorized to perform this action.") {
    super(message, "AUTH_FORBIDDEN");
  }
}

export class InvalidActionTokenError extends AuthError {
  constructor() {
    super("The token is invalid, expired, or has already been used.", "AUTH_INVALID_ACTION_TOKEN");
  }
}

export class LastAdministratorError extends AuthError {
  constructor() {
    super("The final administrator cannot be demoted.", "AUTH_LAST_ADMINISTRATOR");
  }
}

export class UnverifiedUserError extends AuthError {
  constructor() {
    super("The user's email must be verified before assigning an administrator role.", "AUTH_EMAIL_UNVERIFIED");
  }
}

export class UserNotFoundError extends AuthError {
  constructor() {
    super("User was not found.", "AUTH_USER_NOT_FOUND");
  }
}

export class AuthRepositoryError extends AuthError {
  constructor(message = "Authentication storage operation failed.", options?: ErrorOptions) {
    super(message, "AUTH_REPOSITORY", options);
  }
}
