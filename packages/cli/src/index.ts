#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { MongoClient } from "mongodb";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ReleaseVersions {
  "@sethi-backend/auth": string;
  "@sethi-backend/core": string;
  "@sethi-backend/config": string;
  "@sethi-backend/security": string;
  "@sethi-backend/email": string;
  "@sethi-backend/database-mongodb": string;
  "@sethi-backend/adapter-fastify": string;
}

type PackageManager = "npm" | "pnpm" | "yarn";

const cliDirectory = dirname(fileURLToPath(import.meta.url));
const packageManifest = JSON.parse(
  readFileSync(resolve(cliDirectory, "../package.json"), "utf8"),
) as { version: string };
const releaseVersions = JSON.parse(
  readFileSync(resolve(cliDirectory, "release-versions.json"), "utf8"),
) as ReleaseVersions;
const supportedManagers: readonly PackageManager[] = ["npm", "pnpm", "yarn"];

const help = `Sethi Backend CLI

Usage:
  sethi <command> [options]

Commands:
  init <project-name>      Create a Fastify + MongoDB application
  doctor                   Check local runtime and required configuration
  db ping                  Verify the configured MongoDB connection
  dev                      Run the current project's dev script
  build                    Run the current project's build script
  start                    Run the current project's start script
  migrate status           Show database migration status
  migrate up               Apply pending database migrations

Options:
  --help, -h               Show help
  --version, -v            Show CLI version
  --json                   Emit machine-readable diagnostics

Init options:
  --template fastify-mongodb
  --package-manager npm|pnpm|yarn
  --yes                    Use defaults without prompting
  --skip-install           Generate files without installing dependencies
  --force                  Confirm initialization into a non-empty directory
`;

const projectTemplate = (name: string, versions: ReleaseVersions) => {
  const dependencies = {
    ...versions,
    fastify: "^5.12.8",
    mongodb: "^7.8.0",
    zod: "^4.6.7",
  };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const source = `import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createAuthService, createAuthenticationGuard } from "@sethi-backend/auth";
import { loadConfig } from "@sethi-backend/config";
import { createCsrfProtectionHook, createFastifyAdapter, createRedisRateLimitClient, generateCsrfToken, registerHttpSecurity } from "@sethi-backend/adapter-fastify";
import { createMongoAuthActionTokenRepository, createMongoAuthSessionRepository, createMongoAuthUserRepository, createMongoDatabaseAdapter } from "@sethi-backend/database-mongodb";
import { createSmtpEmailSender } from "@sethi-backend/email";
import { createBackend } from "@sethi-backend/core";
import { createPasswordHasher, createTokenService } from "@sethi-backend/security";

const config = loadConfig(z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  APP_BASE_URL: z.string().url().optional(),
}), process.env);

if (Boolean(config.SMTP_HOST) !== Boolean(config.EMAIL_FROM)) {
  throw new Error("SMTP_HOST and EMAIL_FROM must be configured together.");
}
if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD)) {
  throw new Error("SMTP_USER and SMTP_PASSWORD must be configured together.");
}
const useRedis = process.env.RATE_LIMIT_STORE === "redis";
if (config.NODE_ENV === "production" && !useRedis) {
  throw new Error("Production requires RATE_LIMIT_STORE=redis.");
}
if (useRedis && !process.env.REDIS_URL) {
  throw new Error("REDIS_URL is required when RATE_LIMIT_STORE=redis.");
}
if (config.NODE_ENV === "production" &&
    !process.env.REDIS_URL?.startsWith("rediss://")) {
  throw new Error("Production REDIS_URL must use TLS (rediss://).");
}

const database = createMongoDatabaseAdapter({
  uri: config.MONGODB_URI,
  databaseName: config.MONGODB_DATABASE,
});
const users = createMongoAuthUserRepository({
  getDatabase: database.getDatabase,
  getClient: database.getClient,
});
const sessions = createMongoAuthSessionRepository({
  getDatabase: database.getDatabase,
});
const actionTokens = createMongoAuthActionTokenRepository({
  getDatabase: database.getDatabase,
  getClient: database.getClient,
});
const tokens = createTokenService({
  secret: config.JWT_SECRET,
  issuer: "${name}",
  audience: "${name}-api",
});
const emailSender = config.SMTP_HOST && config.EMAIL_FROM
  ? createSmtpEmailSender({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE === "true",
    from: config.EMAIL_FROM,
    ...(config.SMTP_USER && config.SMTP_PASSWORD
      ? { username: config.SMTP_USER, password: config.SMTP_PASSWORD }
      : {}),
  })
  : undefined;
const http = createFastifyAdapter({ logger: config.NODE_ENV !== "test" });

registerHttpSecurity(http.instance, {
  allowedOrigins: config.CORS_ORIGINS.split(",").map((origin) => origin.trim()),
  environment: config.NODE_ENV,
  rateLimit: useRedis
    ? {
      store: "redis",
      redis: createRedisRateLimitClient({ url: process.env.REDIS_URL ?? "" }),
    }
    : { store: "memory" },
});

const auth = await createAuthService({
  users,
  sessions,
  actionTokens,
  tokens,
  passwordHasher: createPasswordHasher(),
  ...(emailSender ? { emailSender } : {}),
  ...(config.APP_BASE_URL ? { appBaseUrl: config.APP_BASE_URL } : {}),
});
const guard = createAuthenticationGuard({ users, sessions, tokens });
const csrf = createCsrfProtectionHook(http.instance);

http.instance.get("/csrf-token", async (_request, reply) => ({
  token: generateCsrfToken(reply),
}));
http.instance.get("/health", async () => ({ status: "ok" }));
http.instance.get("/ready", async (_request, reply) => {
  try {
    await database.getDatabase().command({ ping: 1 });
    return { status: "ready" };
  } catch {
    return reply.code(503).send({ status: "unavailable" });
  }
});
http.instance.post("/auth/register", { onRequest: csrf }, async (request, reply) => {
  await auth.register(request.body);
  return reply.code(202).send({ status: "accepted" });
});
http.instance.post("/auth/verify-email", async (request, reply) => {
  await auth.verifyEmail(request.body);
  return reply.code(204).send();
});
http.instance.post("/auth/login", { onRequest: csrf }, async (request, reply) => {
  const result = await auth.login(request.body);
  reply.header("Cache-Control", "no-store");
  reply.setCookie("refresh_token", result.refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    path: "/auth",
    expires: result.refreshTokenExpiresAt,
  });
  return reply.send({ accessToken: result.accessToken, user: result.user });
});
http.instance.get("/auth/me", async (request, reply) => {
  const user = await guard.authenticate(request.headers.authorization);
  return reply.send({ user: { id: user.id, email: user.email, role: user.role } });
});
http.instance.addHook("onReady", async () => {
  await Promise.all([
    users.ensureIndexes(),
    sessions.ensureIndexes(),
    actionTokens.ensureIndexes(),
  ]);
});

const application = createBackend({
  server: { host: config.HOST, port: config.PORT },
  adapter: http,
  database,
});
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await application.stop();
  } catch (error) {
    process.exitCode = 1;
    console.error("Graceful shutdown failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  await application.start();
  http.instance.log.info({ host: config.HOST, port: config.PORT }, "API listening");
} catch (error) {
  console.error("Application startup failed.", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
}
`;
  return new Map<string, string>([
    ["package.json", json({
      name,
      version: "1.0.0",
      private: true,
      type: "module",
      engines: { node: "^22.12.0 || ^24.0.0 || >=26.0.0" },
      scripts: {
        dev: "tsx watch src/index.ts",
        build: "tsc -p tsconfig.json",
        start: "node dist/index.js",
      },
      dependencies,
      devDependencies: {
        "@types/node": "^24.19.2",
        tsx: "^4.20.3",
        typescript: "^5.9.3",
      },
    })],
    ["tsconfig.json", json({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        types: ["node"],
        outDir: "dist",
      },
      include: ["src/**/*.ts"],
    })],
    ["src/index.ts", source],
    [".env.example", `NODE_ENV=development
HOST=127.0.0.1
PORT=3000
RATE_LIMIT_STORE=memory
REDIS_URL=
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=${name.replaceAll("-", "_")}_dev
JWT_SECRET=
CORS_ORIGINS=http://localhost:5173
RATE_LIMIT_STORE=memory
APP_BASE_URL=http://localhost:5173
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
EMAIL_FROM=
`],
    [".gitignore", `node_modules/
dist/
.env
.env.*
!.env.example
`],
    ["README.md", `# ${name}

Sethi Backend Fastify + MongoDB starter.

## Start

\`\`\`sh
npm install
cp .env.example .env
\`\`\`

Set \`JWT_SECRET\` in \`.env\` to a private random value (the initializer creates
an initial local-only secret). Start MongoDB, then run \`npm run dev\`.

- \`GET /health\` is a liveness endpoint.
- \`GET /ready\` checks MongoDB availability.
- \`POST /auth/register\`, \`POST /auth/verify-email\`, and \`POST /auth/login\`
  provide the starter authentication flow.
- \`GET /auth/me\` demonstrates a protected route using a bearer access token.

For browser clients, first fetch \`GET /csrf-token\`, retain its cookie, and send
the returned token as \`X-CSRF-Token\` with cookie-authenticated POST requests.
Configure SMTP and \`APP_BASE_URL\` to deliver verification emails. Without SMTP,
registration can create the account but email verification cannot be completed.

Build and run with \`npm run build\` and \`npm start\`.
`],
  ]);
};

function isSupportedNode(version: string): boolean {
  const [majorText, minorText] = version.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  return (major === 22 && minor >= 12) || major === 24 || major >= 26;
}

function jsonOption(args: string[]): boolean {
  return args.includes("--json");
}

function loadLocalEnvironment(): void {
  const envFile = resolve(process.cwd(), ".env");
  if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envFile);
  }
}

function detectPackageManager(directory: string): PackageManager {
  const userAgent = process.env.npm_config_user_agent ?? "";
  const managerFromAgent = supportedManagers.find((manager) =>
    userAgent.startsWith(`${manager}/`)
  );
  if (managerFromAgent) return managerFromAgent;
  const lockFiles: Record<PackageManager, string> = {
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    npm: "package-lock.json",
  };
  const managerFromLock = supportedManagers.find((manager) =>
    existsSync(join(directory, lockFiles[manager]))
  );
  return managerFromLock ?? "npm";
}

function emitDiagnostic(
  data: Record<string, unknown>,
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(data));
    return;
  }
  for (const [name, value] of Object.entries(data)) {
    if (typeof value === "object" && value !== null) {
      console.log(`${name}:`);
      for (const [key, detail] of Object.entries(value)) {
        console.log(`  ${key}: ${String(detail)}`);
      }
    } else {
      console.log(`${name}: ${String(value)}`);
    }
  }
}

async function doctor(json: boolean): Promise<number> {
  loadLocalEnvironment();
  const checks = {
    node: { version: process.versions.node, supported: isSupportedNode(process.versions.node) },
    environment: {
      mongodbUri: Boolean(process.env.MONGODB_URI),
      mongodbDatabase: Boolean(process.env.MONGODB_DATABASE),
      jwtSecret: Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32),
      redisUrl: process.env.RATE_LIMIT_STORE === "redis"
        ? Boolean(process.env.REDIS_URL)
        : "not required",
      emailEncryptionKey: process.env.EMAIL_OUTBOX_ENABLED === "true"
        ? Boolean(process.env.EMAIL_ENCRYPTION_KEY)
        : "not required",
    },
    packageManager: detectPackageManager(process.cwd()),
  };
  const requiredOk = checks.node.supported &&
    checks.environment.mongodbUri &&
    checks.environment.mongodbDatabase &&
    checks.environment.jwtSecret &&
    checks.environment.redisUrl !== false &&
    checks.environment.emailEncryptionKey !== false;
  emitDiagnostic({ ok: requiredOk, checks }, json);
  return requiredOk ? 0 : 1;
}

async function pingDatabase(json: boolean): Promise<number> {
  loadLocalEnvironment();
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    emitDiagnostic({ ok: false, error: "MONGODB_URI is not configured." }, json);
    return 1;
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    await client.db(process.env.MONGODB_DATABASE).command({ ping: 1 });
    emitDiagnostic({
      ok: true,
      database: process.env.MONGODB_DATABASE ?? "default",
      message: "MongoDB ping succeeded.",
    }, json);
    return 0;
  } catch {
    emitDiagnostic({ ok: false, error: "MongoDB ping failed." }, json);
    return 1;
  } finally {
    await client.close();
  }
}

async function confirm(question: string): Promise<boolean> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return (await terminal.question(`${question} [y/N] `)).trim().toLowerCase() === "y";
  } finally {
    terminal.close();
  }
}

function parseInitOptions(args: string[]) {
  const options = {
    yes: args.includes("--yes"),
    force: args.includes("--force"),
    skipInstall: args.includes("--skip-install"),
    template: "fastify-mongodb",
    packageManager: undefined as PackageManager | undefined,
  };
  let positionalCount = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === undefined) continue;
    if (option === "--template" || option === "--package-manager") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${option} requires a value.`);
      }
      if (option === "--template") options.template = value;
      else if (supportedManagers.includes(value as PackageManager)) {
        options.packageManager = value as PackageManager;
      } else {
        throw new Error("--package-manager must be npm, pnpm, or yarn.");
      }
      index += 1;
    } else if (
      option !== "--yes" &&
      option !== "--force" &&
      option !== "--skip-install" &&
      !option.startsWith("-")
    ) {
      positionalCount += 1;
    } else if (
      option !== "--yes" &&
      option !== "--force" &&
      option !== "--skip-install"
    ) {
      throw new Error(`Unknown init option: ${option}`);
    }
  }
  if (positionalCount !== 1) {
    throw new Error("Usage: sethi init <project-name> [options].");
  }
  if (options.template !== "fastify-mongodb") {
    throw new Error("Only the fastify-mongodb template is currently supported.");
  }
  return options;
}

function runInstall(manager: PackageManager, directory: string): number {
  const result = spawnSync(manager, ["install"], {
    cwd: directory,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`Could not start ${manager}. Install it or rerun with --skip-install.`);
    return 1;
  }
  if (result.status !== 0) {
    console.error(`${manager} install failed with exit code ${String(result.status)}.`);
    return result.status ?? 1;
  }
  return 0;
}

async function initialize(projectName: string | undefined, args: string[]): Promise<number> {
  if (!projectName || !/^[a-z0-9][a-z0-9._-]*$/.test(projectName) ||
      projectName === "." || projectName === ".." || isAbsolute(projectName)) {
    console.error("Usage: sethi init <project-name> (use lowercase letters, digits, dot, underscore, or hyphen).");
    return 2;
  }
  const options = parseInitOptions(args);
  const targetDirectory = resolve(process.cwd(), projectName);
  const relativeTarget = relative(process.cwd(), targetDirectory);
  if (!relativeTarget || relativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relativeTarget)) {
    console.error("Project path must be a child of the current directory.");
    return 2;
  }

  if (existsSync(targetDirectory) && !lstatSync(targetDirectory).isDirectory()) {
    console.error("The project path exists and is not a directory.");
    return 2;
  }
  const existingFiles = existsSync(targetDirectory)
    ? readdirSync(targetDirectory)
    : [];
  if (existingFiles.length > 0) {
    const allowed = options.force ||
      (!options.yes && stdin.isTTY && await confirm(
        `Directory "${projectName}" is not empty. Confirm writing starter files?`,
      ));
    if (!allowed) {
      console.error("Refusing to initialize into a non-empty directory. Use --force to confirm.");
      return 2;
    }
  }

  const files = projectTemplate(projectName, releaseVersions);
  const jwtSecret = randomBytes(48).toString("base64url");
  const envFile = `.env
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=${projectName.replaceAll("-", "_")}_dev
JWT_SECRET=${jwtSecret}
CORS_ORIGINS=http://localhost:5173
APP_BASE_URL=http://localhost:5173
`;
  files.set(".env", envFile);
const existingOutput = [...files.keys()].find((path) =>
  existsSync(resolve(targetDirectory, path))
);
if (existingOutput) {
  console.error(`Refusing to overwrite existing file: ${existingOutput}`);
  return 2;
}
mkdirSync(targetDirectory, { recursive: true });
for (const [path, content] of files) {
  const outputPath = resolve(targetDirectory, path);
    if (!outputPath.startsWith(`${targetDirectory}${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error("Generated file path escaped the project directory.");
    }
    let parent = targetDirectory;
    for (const segment of dirname(path).split(/[\\/]/).filter(Boolean)) {
      parent = join(parent, segment);
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
        console.error(`Refusing to write through symbolic link: ${segment}`);
        return 2;
      }
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, content, { flag: "wx" });
  }

  const manager = options.packageManager ?? detectPackageManager(process.cwd());
  if (!options.skipInstall) {
    if (!options.yes && stdin.isTTY &&
        !await confirm(`Install dependencies with ${manager}?`)) {
      console.log(`Project created at ${targetDirectory}. Run ${manager} install when ready.`);
      return 0;
    }
    const exitCode = runInstall(manager, targetDirectory);
    if (exitCode !== 0) return exitCode;
  }
  console.log(`Created ${projectName} using fastify-mongodb.`);
  console.log(`Next: cd ${projectName}`);
  if (options.skipInstall) console.log(`Then: ${manager} install`);
  console.log("Set up MongoDB and SMTP in .env, then run npm run dev.");
  return 0;
}

function runProjectScript(script: "dev" | "build" | "start"): number {
  const packagePath = resolve(process.cwd(), "package.json");
  if (!existsSync(packagePath)) {
    console.error("No package.json found in the current directory.");
    return 2;
  }
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (!manifest.scripts?.[script]) {
    console.error(`The current project does not define a "${script}" script.`);
    return 2;
  }
  const result = spawnSync("npm", ["run", script], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error("Could not start npm.");
    return 1;
  }
  return result.status ?? 1;
}

async function main(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return 0;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(packageManifest.version);
    return 0;
  }

  const [command, ...remaining] = args;
  const json = jsonOption(remaining);
  switch (command) {
    case "init":
      return initialize(remaining.find((arg) => !arg.startsWith("--")), remaining);
    case "doctor":
      return doctor(json);
    case "db":
      if (remaining[0] !== "ping") {
        console.error("Usage: sethi db ping [--json]");
        return 2;
      }
      return pingDatabase(json);
    case "dev":
    case "build":
    case "start":
      return runProjectScript(command);
    case "migrate":
      console.error("Migration commands are not available in this CLI version.");
      return 2;
    default:
      console.error(`Unknown command: ${command}\n\nRun "sethi --help" for usage.`);
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "CLI command failed.");
  process.exitCode = 1;
});
