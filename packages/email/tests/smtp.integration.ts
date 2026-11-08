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
  it("sends a test message only to TEST_SMTP_RECIPIENT", async () => {
    const sender = createSmtpEmailSender({
      host: required(host, "SMTP_HOST"),
      port,
      secure,
      from: required(from, "EMAIL_FROM"),
      ...(username && password ? { username, password } : {}),
    });
    await sender.send({
      to: required(recipient, "TEST_SMTP_RECIPIENT"),
      subject: "Sethi Backend SMTP smoke test",
      text: "This message verifies the configured SMTP integration.",
      html: "<p>This message verifies the configured SMTP integration.</p>",
    });
    expect(recipient).toBe(required(process.env.TEST_SMTP_RECIPIENT?.trim(), "TEST_SMTP_RECIPIENT"));
  });
});
