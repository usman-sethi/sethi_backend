import {
  AuthRepositoryError,
  AuthValidationError,
  DuplicateUserError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  UnauthorizedError,
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
  code(statusCode: number): AuthErrorReply;
  send(payload: unknown): unknown;
}

function sendAuthError(
  server: FastifyInstance,
  error: unknown,
  reply: AuthErrorReply,
) {
  if (error instanceof AuthValidationError) {
    return reply.code(400).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  if (error instanceof DuplicateUserError) {
    return reply.code(409).send({
      error: {
        code: error.code,
        message: error.message,
      },
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
      },
    });
  }

  if (error instanceof AuthRepositoryError) {
    server.log.error({ err: error }, "Authentication storage operation failed");
  } else {
    server.log.error({ err: error }, "Authentication request failed");
  }

  return reply.code(500).send({
    error: {
      code: "INTERNAL_ERROR",
      message: "Authentication request failed.",
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
        const result = await options.service.register(request.body);
        reply.code(201);
        return sendAuthenticationResult(reply, result, options.environment);
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
    { onRequest: options.csrfProtection },
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
