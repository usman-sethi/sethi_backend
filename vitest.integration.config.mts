import { defineConfig } from "vitest/config";

const requiredVariables = [
  "TEST_MONGODB_URI",
  "TEST_MONGODB_DATABASE",
  "SMTP_HOST",
  "SMTP_PORT",
  "EMAIL_FROM",
  "TEST_SMTP_RECIPIENT",
  "MAILPIT_API_URL",
];
const missingVariables = requiredVariables.filter((name) =>
  !process.env[name]?.trim()
);

if (missingVariables.length > 0) {
  throw new Error(
    `Integration tests require ${missingVariables.join(", ")}. Start the isolated services and configure the documented test environment.`,
  );
}
if (process.env.SMTP_TEST_ENABLED !== "true") {
  throw new Error("Integration tests require SMTP_TEST_ENABLED=true.");
}
if (!process.env.TEST_MONGODB_DATABASE?.endsWith("_integration_test")) {
  throw new Error(
    "Integration tests require a TEST_MONGODB_DATABASE ending in _integration_test.",
  );
}
if (process.env.SMTP_USER || process.env.SMTP_PASSWORD) {
  throw new Error("Local integration SMTP must not use production credentials.");
}
if (!["localhost", "127.0.0.1", "::1"].includes(
  process.env.SMTP_HOST?.replace(/^\[|\]$/g, "").toLowerCase() ?? "",
)) {
  throw new Error("SMTP_HOST must target a local SMTP test service.");
}
const smtpPort = Number(process.env.SMTP_PORT);
if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
  throw new Error("SMTP_PORT must be a valid TCP port.");
}

export default defineConfig({
  test: {
    include: [
      "packages/database-mongodb/tests/**/*.integration.ts",
      "packages/email/tests/**/*.integration.ts",
    ],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
  },
});
