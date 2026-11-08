import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = process.env.LOCAL_NPM_REGISTRY ?? "http://127.0.0.1:4873/";
const registryUrl = new URL(registry);

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(
    hostname.replace(/^\[|\]$/g, "").toLowerCase(),
  );
}

if (registryUrl.protocol !== "http:" || !isLoopback(registryUrl.hostname)) {
  throw new Error(
    "LOCAL_NPM_REGISTRY must be a local HTTP registry; public registry publishing is disabled.",
  );
}

const requiredVariables = [
  "TEST_MONGODB_URI",
  "TEST_MONGODB_DATABASE",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_TEST_ENABLED",
  "EMAIL_FROM",
  "TEST_SMTP_RECIPIENT",
  "MAILPIT_API_URL",
];
const missingVariables = requiredVariables.filter((name) =>
  !process.env[name]?.trim()
);
if (missingVariables.length > 0) {
  throw new Error(
    `Package consumer validation requires ${missingVariables.join(", ")}.`,
  );
}
if (process.env.SMTP_TEST_ENABLED !== "true") {
  throw new Error("Package consumer validation requires SMTP_TEST_ENABLED=true.");
}
if (process.env.SMTP_USER || process.env.SMTP_PASSWORD) {
  throw new Error("Package consumer validation must not use SMTP credentials.");
}
if (!/^[a-zA-Z0-9_-]+_integration_test$/.test(process.env.TEST_MONGODB_DATABASE)) {
  throw new Error(
    "TEST_MONGODB_DATABASE must be a disposable name ending in _integration_test.",
  );
}
if (process.env.TEST_MONGODB_DATABASE.length > 46) {
  throw new Error(
    "TEST_MONGODB_DATABASE must be at most 46 characters to allow isolated test databases.",
  );
}
const mongoUrl = new URL(process.env.TEST_MONGODB_URI);
if (
  !["mongodb:", "mongodb+srv:"].includes(mongoUrl.protocol) ||
  !isLoopback(mongoUrl.hostname) ||
  mongoUrl.username ||
  mongoUrl.password
) {
  throw new Error(
    "Package consumer validation only allows a local MongoDB test host without credentials.",
  );
}
const mailpitUrl = new URL(process.env.MAILPIT_API_URL);
if (mailpitUrl.protocol !== "http:" || !isLoopback(mailpitUrl.hostname)) {
  throw new Error("MAILPIT_API_URL must target a local HTTP service.");
}
if (!isLoopback(process.env.SMTP_HOST)) {
  throw new Error("SMTP_HOST must target a local SMTP test service.");
}

function run(command, args, options = {}) {
  const { input, ...commandOptions } = options;
  execFileSync(command, args, {
    cwd: root,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32" && command !== process.execPath,
    ...commandOptions,
    ...(input === undefined ? {} : { input }),
  });
}

async function waitForRegistry() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("-/ping", registryUrl));
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(
    "The local Verdaccio registry is not responding at LOCAL_NPM_REGISTRY.",
  );
}

async function createRegistryUser(username, password) {
  const response = await fetch(
    new URL(`-/user/org.couchdb.user:${username}`, registryUrl),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: username,
        password,
        email: `${username}@example.test`,
        type: "user",
        roles: [],
        date: new Date().toISOString(),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not create an ephemeral Verdaccio user (HTTP ${response.status}).`,
    );
  }
  const result = await response.json();
  if (typeof result.token !== "string" || result.token.length === 0) {
    throw new Error("Verdaccio did not return an authentication token.");
  }
  return result.token;
}

const packageDirectories = [
  "auth",
  "core",
  "config",
  "security",
  "email",
  "database-mongodb",
  "adapter-fastify",
].map((name) => join(root, "packages", name));
const consumerDirectory = mkdtempSync(
  join(tmpdir(), "sethi-package-consumer-"),
);
const consumerDatabase =
  `consumer_${randomUUID().replaceAll("-", "").slice(0, 12)}_integration_test`;
const tarballDirectory = join(consumerDirectory, "tarballs");
const cacheDirectory = join(consumerDirectory, "npm-cache");
const installDirectory = join(consumerDirectory, "consumer");
const npmConfigPath = join(consumerDirectory, "npmrc");
const manifests = packageDirectories.map((directory) =>
  JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
);

try {
  await waitForRegistry();
  run("pnpm", ["--recursive", "--filter", "./packages/*", "build"]);
  for (const directory of [tarballDirectory, cacheDirectory, installDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
  const registryUser = `sethi-test-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const registryPassword = randomBytes(32).toString("base64url");
  const registryToken = await createRegistryUser(
    registryUser,
    registryPassword,
  );
  writeFileSync(
    npmConfigPath,
    `registry=${registryUrl}\n//${registryUrl.host}/:_authToken=${registryToken}\n`,
  );

  for (const directory of packageDirectories) {
    const tarballsBeforePack = new Set(
      readdirSync(tarballDirectory).filter((name) => name.endsWith(".tgz")),
    );
    run("pnpm", [
      "--dir",
      directory,
      "pack",
      "--pack-destination",
      tarballDirectory,
    ]);
    const tarballs = readdirSync(tarballDirectory).filter((name) =>
      name.endsWith(".tgz")
    );
    const newTarballs = tarballs.filter((name) => !tarballsBeforePack.has(name));
    if (newTarballs.length !== 1) {
      throw new Error(`Expected one package tarball for ${directory}.`);
    }
    const tarball = join(tarballDirectory, newTarballs[0]);
    run("npm", [
      "publish",
      tarball,
      "--registry",
      registryUrl.toString(),
      "--access",
      "public",
      "--ignore-scripts",
      "--cache",
      cacheDirectory,
      "--userconfig",
      npmConfigPath,
    ]);
  }

  const dependencies = Object.fromEntries(
    manifests.map(({ name, version }) => [name, version]),
  );
  Object.assign(dependencies, {
    "@types/node": "^24.19.2",
    fastify: "^5.12.8",
    mongodb: "^7.8.0",
    typescript: "^5.9.3",
    zod: "^4.6.7",
  });
  writeFileSync(join(installDirectory, "package.json"), JSON.stringify({
    name: "sethi-independent-package-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies,
  }, null, 2));
  writeFileSync(join(installDirectory, "tsconfig.json"), JSON.stringify({
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
  }, null, 2));
  mkdirSync(join(installDirectory, "src"), { recursive: true });
  writeFileSync(
    join(installDirectory, "src", "consumer.ts"),
    readFileSync(join(root, "tests", "package-consumer", "consumer.ts")),
  );
  run("npm", [
    "install",
    "--registry",
    registryUrl.toString(),
    "--no-audit",
    "--no-fund",
    "--fetch-timeout=180000",
    "--cache",
    cacheDirectory,
    "--userconfig",
    npmConfigPath,
  ], { cwd: installDirectory });
  run("npm", ["exec", "--", "tsc", "-p", "tsconfig.json"], {
    cwd: installDirectory,
  });
  run(process.execPath, [join(installDirectory, "dist", "consumer.js")], {
    cwd: installDirectory,
    env: {
      ...process.env,
      TEST_MONGODB_DATABASE: consumerDatabase,
    },
  });
} finally {
  rmSync(consumerDirectory, { recursive: true, force: true });
}
