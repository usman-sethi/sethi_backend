import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const compiler = resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

execFileSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
  cwd: packageDirectory,
  stdio: "inherit",
});

const packageNames = [
  "@sethi-backend/auth",
  "@sethi-backend/core",
  "@sethi-backend/config",
  "@sethi-backend/security",
  "@sethi-backend/email",
  "@sethi-backend/database-mongodb",
  "@sethi-backend/adapter-fastify",
];
const versions = Object.fromEntries(packageNames.map((name) => {
  const packagePath = resolve(
    repositoryRoot,
    "packages",
    name.slice("@sethi-backend/".length),
    "package.json",
  );
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  if (manifest.name !== name || typeof manifest.version !== "string") {
    throw new Error(`Invalid release manifest for ${name}.`);
  }
  return [name, manifest.version];
}));

const outputDirectory = resolve(packageDirectory, "dist");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, "release-versions.json"),
  `${JSON.stringify(versions, null, 2)}\n`,
);
