import {
  describe,
  expect,
  it,
} from "vitest";
import { randomUUID } from "node:crypto";

import { createSmtpEmailSender } from "@sethi-backend/email";

const recipient = process.env.TEST_SMTP_RECIPIENT?.trim();
const host = process.env.SMTP_HOST?.trim();
const from = process.env.EMAIL_FROM?.trim();
const port = Number(process.env.SMTP_PORT ?? "587");
const secure = process.env.SMTP_SECURE === "true";
const username = process.env.SMTP_USER?.trim();
const password = process.env.SMTP_PASSWORD;
const mailpitApiUrl = process.env.MAILPIT_API_URL?.trim();

if (!recipient || !host || !from || !mailpitApiUrl) {
  throw new Error(
    "SMTP smoke test requires SMTP_HOST, EMAIL_FROM, TEST_SMTP_RECIPIENT, and MAILPIT_API_URL.",
  );
}
if (Boolean(username) !== Boolean(password)) {
  throw new Error("SMTP smoke test credentials must be provided together.");
}
const mailpitUrl = new URL(mailpitApiUrl);
if (
  mailpitUrl.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "::1"].includes(
    mailpitUrl.hostname.replace(/^\[|\]$/g, ""),
  ) ||
  mailpitUrl.username ||
  mailpitUrl.password
) {
  throw new Error("MAILPIT_API_URL must target a local HTTP service.");
}

function required(value: string | undefined, field: string): string {
  if (!value) {
    throw new Error(`SMTP smoke test requires ${field}.`);
  }
  return value;
}

describe("SMTP delivery integration", () => {
  it("sends verification and password-reset fixtures only to TEST_SMTP_RECIPIENT", async () => {
    const sender = createSmtpEmailSender({
      host: required(host, "SMTP_HOST"),
      port,
      secure,
      from: required(from, "EMAIL_FROM"),
      ...(username && password ? { username, password } : {}),
    });
    const testRecipient = required(recipient, "TEST_SMTP_RECIPIENT");
    const marker = randomUUID();
    const messages = [
      {
        to: testRecipient,
        subject: `Sethi Backend email verification smoke test ${marker}`,
        text: "Verify your address: https://example.test/verify-email#token=test-verification-token",
        html: '<p><a href="https://example.test/verify-email#token=test-verification-token">Verify email</a></p>',
      },
      {
        to: testRecipient,
        subject: `Sethi Backend password reset smoke test ${marker}`,
        text: "Reset your password: https://example.test/reset-password#token=test-reset-token",
        html: '<p><a href="https://example.test/reset-password#token=test-reset-token">Reset password</a></p>',
      },
    ] as const;
    for (const message of messages) {
      await sender.send(message);
    }

    const summaries = await waitForMailpitMessages(marker);
    expect(summaries).toHaveLength(messages.length);
    for (const message of messages) {
      const summary = summaries.find((item) => item.Subject === message.subject);
      if (!summary) {
        throw new Error(`Mailpit did not store "${message.subject}".`);
      }
      expect(JSON.stringify(summary.To)).toContain(testRecipient);
      const delivered = await mailpitRequest<{
        Text?: string;
        HTML?: string;
      }>(`/api/v1/message/${encodeURIComponent(summary.ID)}`);
      expect(delivered.Text).toContain(message.text);
      expect(delivered.HTML).toContain(message.html);
    }
  });
});

interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  To: unknown;
}

async function mailpitRequest<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, mailpitUrl));
  if (!response.ok) {
    throw new Error(
      `Mailpit API request failed with HTTP ${response.status}.`,
    );
  }
  return await response.json() as T;
}

async function waitForMailpitMessages(
  marker: string,
): Promise<MailpitMessageSummary[]> {
  const deadline = Date.now() + 10_000;
  let matches: MailpitMessageSummary[] = [];
  while (Date.now() < deadline) {
    const result = await mailpitRequest<{
      messages?: MailpitMessageSummary[];
    }>("/api/v1/messages?start=0&limit=100");
    matches = (result.messages ?? []).filter((message) =>
      message.Subject?.includes(marker)
    );
    if (matches.length === 2) {
      return matches;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Mailpit did not receive both SMTP test messages (received ${matches.length}/2).`,
  );
}
