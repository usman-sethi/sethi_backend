
/**
 * Server configuration shared by HTTP adapters.
 */
export interface ServerOptions {
  host: string;
  port: number;
}

/**
 * Every HTTP adapter must implement this contract.
 *
 * Fastify, Express or another server can implement it.
 */
export interface HttpServerAdapter {
  start(options: ServerOptions): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Every database adapter must implement this contract.
 *
 * MongoDB will be our first implementation.
 */
export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Configuration accepted by the core application.
 */
export interface BackendConfig {
  server: ServerOptions;
  adapter: HttpServerAdapter;
  database: DatabaseAdapter;
}

/**
 * Possible states of the backend application.
 */
export type BackendState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped";

/**
 * Public application API.
 */
export interface BackendApplication {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): BackendState;
}
