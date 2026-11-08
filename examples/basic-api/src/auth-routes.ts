import {
  AuthRepositoryError,
  AuthValidationError,
  DuplicateUserError,
  ForbiddenError,
  InvalidCredentialsError,
  InvalidActionTokenError,
  InvalidRefreshTokenError,
  LastAdministratorError,
  UnauthorizedError,
  UserNotFoundError,
  type AuthService,
  type AuthenticationGuard,
} from "@sethi-backend/auth";
import type {
  FastifyHttpAdapter,
} from "@sethi-backend/adapter-fastify";
import {
  getHttpCookieOptions,
  type HttpSecurityEnvironment,
} from "@sethi-backend/adapter-fastify";
import type { onRequestHookHandler } from "fastify";

type FastifyInstance = FastifyHttpAdapter["instance"];
const REFRESH_COOKIE_NAME = "refresh_token";

interface AuthErrorReply {
  request: { id: string };
  code(statusCode: number): AuthErrorReply;
  send(payload: unknown): unknown;
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error";
}

function sendAuthError(
  server: FastifyInstance,
  error: unknown,
  reply: AuthErrorReply,
) {
  const requestId = reply.request.id;
  if (error instanceof AuthValidationError) {
    return reply.code(400).send({
      error: {
        code: error.code,
        message: error.message,
        requestId,
      },
    });
  }

  if (error instanceof DuplicateUserError) {
    return reply.code(409).send({
      error: {
        code: error.code,
        message: error.message,
        requestId,
      },
    });
  }

  if (error instanceof InvalidActionTokenError) {
    return reply.code(400).send({
      error: { code: error.code, message: error.message, requestId },
    });
  }

  if (error instanceof ForbiddenError) {
    return reply.code(403).send({
      error: { code: error.code, message: error.message, requestId },
    });
  }

  if (error instanceof UserNotFoundError) {
    return reply.code(404).send({
      error: { code: error.code, message: error.message, requestId },
    });
  }

  if (error instanceof LastAdministratorError) {
    return reply.code(409).send({
      error: { code: error.code, message: error.message, requestId },
    });
  }

  if (
    error instanceof InvalidCredentialsError ||
    error instanceof InvalidRefreshTokenError ||
    error instanceof UnauthorizedError
  ) {
    return reply.code(401).send({
      error: {
        code: error.code,
        message: error.message,
        requestId,
      },
    });
  }

  if (error instanceof AuthRepositoryError) {
    server.log.error(
      { event: "auth.request.failed", requestId, errorName: safeErrorName(error) },
      "Authentication storage operation failed",
    );
  } else {
    server.log.error(
      {
        event: "auth.request.failed",
        requestId,
        errorName: safeErrorName(error),
      },
      "Authentication request failed",
    );
  }

  return reply.code(500).send({
    error: {
      code: "INTERNAL_ERROR",
      message: "Authentication request failed.",
      requestId,
    },
  });
}

export interface RegisterAuthRoutesOptions {
  service: AuthService;
  guard: AuthenticationGuard;
  environment: HttpSecurityEnvironment;
  csrfProtection: onRequestHookHandler;
}

function sendAuthenticationResult(
  reply: AuthErrorReply & {
    setCookie(name: string, value: string, options: object): unknown;
    header(name: string, value: string): unknown;
  },
  result: Awaited<ReturnType<AuthService["login"]>>,
  environment: HttpSecurityEnvironment,
) {
  reply.header("Cache-Control", "no-store");
  reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, {
    ...getHttpCookieOptions(environment),
    path: "/auth",
    expires: result.refreshTokenExpiresAt,
  });

  return reply.send({
    accessToken: result.accessToken,
    user: result.user,
  });
}

export function registerAuthRoutes(
  server: FastifyInstance,
  options: RegisterAuthRoutesOptions,
): void {
  server.post(
    "/auth/register",
    {
      onRequest: options.csrfProtection,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      try {
        await options.service.register(request.body);
        reply.header("Cache-Control", "no-store");
        return reply.code(202).send({
          message: "If registration can be completed, verification instructions will be sent.",
        });
      } catch (error) {
        return sendAuthError(server, error, reply);
      }
    },
  );

  server.post(
    "/auth/verify-email",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      try {
        await options.service.verifyEmail(request.body);
        reply.header("Cache-Control", "no-store");
        return reply.code(204).send();
      } catch (error) {
        return sendAuthError(server, error, reply);
      }
    },
  );

  server.post(
    "/auth/resend-verification",
    {
      config: {
        rateLimit: { max: 3, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      try {
        await options.service.resendVerification(request.body);
        reply.header("Cache-Control", "no-store");
        return reply.code(202).send({
          message: "If an account exists for this email, verification instructions will be sent.",
        });
      } catch (error) {
        return sendAuthError(server, error, reply);
      }
    },
  );

  server.post(
    "/auth/forgot-password",
    {
      config: {
        rateLimit: { max: 3, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      try {
        await options.service.requestPasswordReset(request.body);
        reply.header("Cache-Control", "no-store");
        return reply.code(202).send({
          message: "If an account exists for this email, password reset instructions will be sent.",
        });
      } catch (error) {
        return sendAuthError(server, error, reply);
      }
    },
  );

  server.post(
    "/auth/reset-password",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      try {
        await options.service.resetPassword(request.body);
        reply.clearCookie(REFRESH_COOKIE_NAME, {
          ...getHttpCookieOptions(options.environment),
          path: "/auth",
        });
        reply.header("Cache-Control", "no-store");
        return reply.code(204).send();
      } catch (error) {
        return sendAuthError(server, error, reply);
      }
    },
  );

  server.post(
    "/auth/login",
    {
      onRequest: options.csrfProtection,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await options.service.login(request.body);
        return sendAuthenticationResult(reply, result, options.environment);
      } catch (error) {
        return sendAuthError(server, error, reply);
      }
    },
  );

  server.post(
    "/auth/refresh",
    {
      onRequest: options.csrfProtection,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await options.service.refresh(
          request.cookies?.[REFRESH_COOKIE_NAME] ?? "",
        );
        return sendAuthenticationResult(reply, result, options.environment);
      } catch (error) {
        return sendAuthError(server, error, reply);
      }
    },
  );

  server.post(
    "/auth/logout",
    { onRequest: options.csrfProtection },
    async (request, reply) => {
      try {
        await options.service.logout(
          request.cookies?.[REFRESH_COOKIE_NAME],
        );
        reply.clearCookie(REFRESH_COOKIE_NAME, {
          ...getHttpCookieOptions(options.environment),
          path: "/auth",
        });
        return reply.code(204).send();
      } catch (error) {
        return sendAuthError(server, error, reply);
      }
    },
  );

  server.post(
    "/auth/logout-all",
    { onRequest: options.csrfProtection },
    async (request, reply) => {
      try {
        const user = await options.guard.authenticate(
          request.headers.authorization,
        );
        await options.service.logoutAll(user.id);
        reply.clearCookie(REFRESH_COOKIE_NAME, {
          ...getHttpCookieOptions(options.environment),
          path: "/auth",
        });
        return reply.code(204).send();
      } catch (error) {
        return sendAuthError(server, error, reply);
      }
    },
  );

  server.get("/auth/me", async (request, reply) => {
    try {
      const user = await options.guard.authenticate(
        request.headers.authorization,
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({ user });
    } catch (error) {
      return sendAuthError(server, error, reply);
    }
  });
}
