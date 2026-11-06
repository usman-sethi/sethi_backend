
import type {
  BackendApplication,
  BackendConfig,
  BackendState,
} from "./types.js";

/**
 * Creates a backend application.
 *
 * The core coordinates infrastructure without depending
 * on any particular HTTP server or database.
 */
export function createBackend(
  config: BackendConfig,
): BackendApplication {
  let state: BackendState = "idle";

  async function start(): Promise<void> {
    // Starting an already-running application is harmless.
    if (state === "running") {
      return;
    }

    if (state !== "idle") {
      throw new Error(
        `Cannot start backend while state is "${state}".`,
      );
    }

    state = "starting";

    let databaseConnectAttempted = false;
    let adapterStartAttempted = false;

    try {
      // 1. Initialize database infrastructure.
      databaseConnectAttempted = true;
      await config.database.connect();

      // 2. Start the HTTP server.
      adapterStartAttempted = true;
      await config.adapter.start(config.server);

      state = "running";
    } catch (error) {
      const cleanupErrors: unknown[] = [];

      // Clean up a partially initialized HTTP server.
      if (adapterStartAttempted) {
        try {
          await config.adapter.stop();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }

      // Clean up database resources.
      if (databaseConnectAttempted) {
        try {
          await config.database.disconnect();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }

      // A failed cleanup means the application cannot
      // safely be restarted without further intervention.
      state = cleanupErrors.length > 0 ? "stopped" : "idle";

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Backend startup failed and cleanup was unsuccessful.",
        );
      }

      throw error;
    }
  }

  async function stop(): Promise<void> {
    // Repeated shutdown requests should be harmless.
    if (state === "stopped") {
      return;
    }

    if (state === "idle") {
      state = "stopped";
      return;
    }

    if (state !== "running") {
      throw new Error(
        `Cannot stop backend while state is "${state}".`,
      );
    }

    state = "stopping";

    const shutdownErrors: unknown[] = [];

    // Attempt both shutdown operations even if one fails.
    try {
      await config.adapter.stop();
    } catch (error) {
      shutdownErrors.push(error);
    }

    try {
      await config.database.disconnect();
    } catch (error) {
      shutdownErrors.push(error);
    }

    state = "stopped";

    if (shutdownErrors.length > 0) {
      throw new AggregateError(
        shutdownErrors,
        "Backend shutdown completed with errors.",
      );
    }
  }

  return {
    start,
    stop,

    getState(): BackendState {
      return state;
    },
  };
}
