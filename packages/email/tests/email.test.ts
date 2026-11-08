import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  createTransport: mocks.createTransport,
}));

import { createSmtpEmailSender } from "../src/index.js";

describe("SMTP email sender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMail.mockResolvedValue({ rejected: [] });
    mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
  });

  it("sends plain-text and HTML messages through the configured SMTP transport", async () => {
    const sender = createSmtpEmailSender({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      username: "smtp-user",
      password: "smtp-password",
      from: "Sethi <no-reply@example.com>",
    });

    await sender.send({
      to: "user@example.com",
      subject: "Verify your email",
      text: "Verify this address.",
      html: "<p>Verify this address.</p>",
    });

    expect(mocks.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "smtp-user", pass: "smtp-password" },
    });
    expect(mocks.sendMail).toHaveBeenCalledWith({
      from: "Sethi <no-reply@example.com>",
      to: "user@example.com",
      subject: "Verify your email",
      text: "Verify this address.",
      html: "<p>Verify this address.</p>",
    });
  });

  it("rejects invalid transport settings and SMTP recipient failures", async () => {
    expect(() => createSmtpEmailSender({
      host: "",
      port: 587,
      secure: false,
      from: "no-reply@example.com",
    })).toThrow("SMTP host and sender address are required.");
    expect(() => createSmtpEmailSender({
      host: "smtp.example.com",
      port: 0,
      secure: false,
      from: "no-reply@example.com",
    })).toThrow("SMTP port");
    expect(() => createSmtpEmailSender({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      username: "only-user",
      from: "no-reply@example.com",
    })).toThrow("must be configured together");

    mocks.sendMail.mockResolvedValueOnce({ rejected: ["user@example.com"] });
    const sender = createSmtpEmailSender({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      from: "no-reply@example.com",
    });
    await expect(sender.send({
      to: "user@example.com",
      subject: "Test",
      text: "Text",
      html: "<p>Text</p>",
    })).rejects.toThrow("rejected");
  });
});
