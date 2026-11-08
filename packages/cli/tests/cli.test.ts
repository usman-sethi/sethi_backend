import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const packageDirectory = resolve(import.meta.dirname, "..");
const cliPath = resolve(packageDirectory, "dist", "index.js");

beforeAll(() => {
  execFileSync(process.execPath, [join(packageDirectory, "scripts", "build.mjs")], {
    cwd: packageDirectory,
    stdio: "inherit",
  });
});

function runCli(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("Sethi CLI process", () => {
  it("prints help and version", () => {
    const help = runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("init <project-name>");

    const version = runCli(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("0.1.0");
  });

  it("returns usage errors for unknown commands and invalid project names", () => {
    expect(runCli(["unknown"]).status).toBe(2);
    expect(runCli(["init", ".."]).status).toBe(2);
    expect(runCli(["migrate", "up"]).status).toBe(2);
  });

  it("creates a starter with published versions and an ignored random local secret", () => {
    const directory = mkdtempSync(join(tmpdir(), "sethi-cli-test-"));
    try {
      const result = runCli([
        "init",
        "my-api",
        "--yes",
        "--skip-install",
        "--package-manager",
        "pnpm",
      ], directory);
      expect(result.status).toBe(0);
      const project = join(directory, "my-api");
      const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
      expect(manifest.dependencies["@sethi-backend/auth"]).toBe("0.1.0");
      expect(manifest.dependencies["@sethi-backend/cli"]).toBeUndefined();
      const env = readFileSync(join(project, ".env"), "utf8");
      expect(env).toMatch(/JWT_SECRET=[A-Za-z0-9_-]{64}/);
      expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".env");
      expect(readFileSync(join(project, "src", "index.ts"), "utf8")).toContain(
        'from "@sethi-backend/database-mongodb"',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to write into a non-empty directory without explicit confirmation", () => {
    const directory = mkdtempSync(join(tmpdir(), "sethi-cli-existing-"));
    try {
      const project = join(directory, "existing");
      mkdirSync(project);
      writeFileSync(join(project, "keep.txt"), "preserve");
      const result = runCli(["init", "existing", "--yes", "--skip-install"], directory);
      expect(result.status).toBe(2);
      expect(readFileSync(join(project, "keep.txt"), "utf8")).toBe("preserve");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
