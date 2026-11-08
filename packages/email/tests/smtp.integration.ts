import {
  describe,
  expect,
  it,
} from "vitest";

import { createSmtpEmailSender } from "../src/index.js";

const enabled = process.env.SMTP_TEST_ENABLED === "true";
const recipient = process.env.TEST_SMTP_RECIPIENT?.trim();
const host = process.env.SMTP_HOST?.trim();
const from = process.env.EMAIL_FROM?.trim();
const port = Number(process.env.SMTP_PORT ?? "587");
const secure = process.env.SMTP_SECURE === "true";
const username = process.env.SMTP_USER?.trim();
const password = process.env.SMTP_PASSWORD;

if (enabled && (!recipient || !host || !from)) {
  throw new Error(
    "SMTP smoke test requires SMTP_TEST_ENABLED=true, SMTP_HOST, EMAIL_FROM, and TEST_SMTP_RECIPIENT.",
  );
}
if (enabled && Boolean(username) !== Boolean(password)) {
  throw new Error("SMTP smoke test credentials must be provided together.");
}

function required(value: string | undefined, field: string): string {
  if (!value) {
    throw new Error(`SMTP smoke test requires ${field}.`);
  }
  return value;
}

describe.skipIf(!enabled)("Opt-in SMTP smoke test", () => {
  it("sends verification and password-reset fixtures only to TEST_SMTP_RECIPIENT", async () => {
    const sender = createSmtpEmailSender({
      host: required(host, "SMTP_HOST"),
      port,
      secure,
      from: required(from, "EMAIL_FROM"),
      ...(username && password ? { username, password } : {}),
    });
    const testRecipient = required(recipient, "TEST_SMTP_RECIPIENT");
    const messages = [
      {
        to: testRecipient,
        subject: "Sethi Backend email verification smoke test",
        text: "Verify your address: https://example.test/verify-email#token=test-verification-token",
        html: '<p><a href="https://example.test/verify-email#token=test-verification-token">Verify email</a></p>',
      },
      {
        to: testRecipient,
        subject: "Sethi Backend password reset smoke test",
        text: "Reset your password: https://example.test/reset-password#token=test-reset-token",
        html: '<p><a href="https://example.test/reset-password#token=test-reset-token">Reset password</a></p>',
      },
    ] as const;
    for (const message of messages) {
      await sender.send(message);
    }
    expect(recipient).toBe(required(process.env.TEST_SMTP_RECIPIENT?.trim(), "TEST_SMTP_RECIPIENT"));
  });
});
