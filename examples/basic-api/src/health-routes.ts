import type { FastifyHttpAdapter } from "@sethi-backend/adapter-fastify";

type FastifyInstance = FastifyHttpAdapter["instance"];

export function registerHealthRoutes(
  server: FastifyInstance,
  checkReadiness: () => Promise<void>,
): void {
  server.get("/health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      status: "ok",
      service: "sethi-backend",
      uptimeSeconds: Math.floor(process.uptime()),
    };
  });

  server.get("/ready", async (request, reply) => {
    try {
      await checkReadiness();
      reply.header("Cache-Control", "no-store");
      return reply.code(200).send({
        status: "ready",
        database: "reachable",
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      request.log.warn({
        event: "database.readiness_failed",
        requestId: request.id,
        errorName: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(errorName)
          ? errorName
          : "Error",
      }, "Database readiness check failed");
      reply.header("Cache-Control", "no-store");
      return reply.code(503).send({
        status: "not_ready",
        database: "unavailable",
      });
    }
  });
}
