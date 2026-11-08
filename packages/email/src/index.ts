import { createTransport } from "nodemailer";

import type { EmailSender } from "@sethi-backend/auth";

export interface SmtpEmailSenderOptions {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  username?: string;
  password?: string;
}

export function createSmtpEmailSender(
  options: SmtpEmailSenderOptions,
): EmailSender {
  const host = options.host.trim();
  const from = options.from.trim();
  if (!host || !from) {
    throw new TypeError("SMTP host and sender address are required.");
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new RangeError("SMTP port must be between 1 and 65535.");
  }
  if (Boolean(options.username) !== Boolean(options.password)) {
    throw new TypeError("SMTP username and password must be configured together.");
  }

  const transporter = createTransport({
    host,
    port: options.port,
    secure: options.secure,
    ...(options.username && options.password
      ? { auth: { user: options.username, pass: options.password } }
      : {}),
  });

  return {
    async send(message): Promise<void> {
      if (!message.to.trim() || !message.subject.trim()) {
        throw new TypeError("Email recipient and subject are required.");
      }
      const result = await transporter.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      if (result.rejected.length > 0) {
        throw new Error("SMTP server rejected one or more recipients.");
      }
    },
  };
}
