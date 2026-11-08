import {
  AuthRepositoryError,
  AuthValidationError,
  ForbiddenError,
  LastAdministratorError,
  UnauthorizedError,
  UnverifiedUserError,
  UserNotFoundError,
  requirePermission,
  USER_ROLES,
  type AuthService,
  type AuthenticationGuard,
  type AuthUserRepository,
  type Permission,
  type PublicAuthUser,
} from "@sethi-backend/auth";
import type { FastifyHttpAdapter } from "@sethi-backend/adapter-fastify";
import type { preHandlerHookHandler } from "fastify";
import { z, ZodError } from "zod";

type FastifyInstance = FastifyHttpAdapter["instance"];

declare module "fastify" {
  interface FastifyRequest {
    authenticatedUser: PublicAuthUser | null;
  }
}

const roleChangeSchema = z.object({
  role: z.enum(USER_ROLES),
}).strict();

export interface RegisterAdminRoutesOptions {
  guard: AuthenticationGuard;
  users: AuthUserRepository;
  service: AuthService;
}

function sendFailure(
  server: FastifyInstance,
  reply: {
    request: { id: string };
    code(statusCode: number): { send(payload?: unknown): unknown };
  },
  error: unknown,
): unknown {
  const requestId = reply.request.id;
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const safeName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(errorName)
    ? errorName
    : "Error";

  if (error instanceof UnauthorizedError) {
    return reply.code(401).send({
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
  if (error instanceof UnverifiedUserError) {
    return reply.code(409).send({
      error: { code: error.code, message: error.message, requestId },
    });
  }
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: {
        code: "AUTH_VALIDATION",
        message: "Role input is invalid.",
        requestId,
      },
    });
  }
  if (error instanceof AuthValidationError) {
    return reply.code(400).send({
      error: { code: error.code, message: error.message, requestId },
    });
  }
  if (error instanceof AuthRepositoryError) {
    server.log.error(
      { event: "admin.request.failed", requestId, errorName: safeName },
      "Administrative storage operation failed",
    );
  } else {
    server.log.error(
      {
        event: "admin.request.failed",
        requestId,
        errorName: safeName,
      },
      "Administrative request failed",
    );
  }
  return reply.code(500).send({
    error: {
      code: "INTERNAL_ERROR",
      message: "Request failed.",
      requestId,
    },
  });
}

export function registerAdminRoutes(
  server: FastifyInstance,
  options: RegisterAdminRoutesOptions,
): void {
  server.decorateRequest("authenticatedUser", null);

  const authenticate: preHandlerHookHandler = async (request, reply) => {
    try {
      request.authenticatedUser = await options.guard.authenticate(
        request.headers.authorization,
      );
    } catch (error) {
      return sendFailure(server, reply, error);
    }
  };

  const requirePermissionHook = (
    permission: Permission,
  ): preHandlerHookHandler => async (request, reply) => {
    const user = request.authenticatedUser;
    if (!user) {
      return sendFailure(server, reply, new UnauthorizedError());
    }
    try {
      requirePermission(user, permission);
    } catch (error) {
      return sendFailure(server, reply, error);
    }
  };

  server.get(
    "/admin/dashboard",
    { preHandler: [authenticate, requirePermissionHook("roles:manage")] },
    async () => ({ status: "ok" }),
  );

  server.get(
    "/admin/users",
    { preHandler: [authenticate, requirePermissionHook("users:read")] },
    async (_request, reply) => {
      try {
        reply.header("Cache-Control", "no-store");
        return { users: await options.users.list() };
      } catch (error) {
        return sendFailure(server, reply, error);
      }
    },
  );

  server.patch<{ Params: { userId: string }; Body: unknown }>(
    "/admin/users/:userId/role",
    { preHandler: [authenticate, requirePermissionHook("roles:manage")] },
    async (request, reply) => {
      try {
        const { role } = roleChangeSchema.parse(request.body);
        const user = request.authenticatedUser;
        if (!user) {
          throw new UnauthorizedError();
        }
        await options.service.changeUserRole(
          request.params.userId,
          role,
          user.id,
        );
        return reply.code(204).send();
      } catch (error) {
        return sendFailure(server, reply, error);
      }
    },
  );
}
