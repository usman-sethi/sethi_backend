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
