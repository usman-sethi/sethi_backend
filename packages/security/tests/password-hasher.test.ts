import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createPasswordHasher,
} from "../src/index.js";

describe("Argon2id Password Hasher", () => {
  const passwordHasher = createPasswordHasher();

  const password = "Correct-Horse-Battery-Staple-123!";

  it("should generate an Argon2id password hash", async () => {
    const hash = await passwordHasher.hash(password);

    expect(hash).toMatch(/^\$argon2id\$v=19\$/);

    expect(hash).toContain(
      "$m=19456,t=2,p=1$",
    );

    expect(hash).not.toBe(password);
  });

  it("should generate different hashes for the same password", async () => {
    const firstHash = await passwordHasher.hash(password);
    const secondHash = await passwordHasher.hash(password);

    expect(firstHash).not.toBe(secondHash);
  });

  it("should verify the correct password", async () => {
    const hash = await passwordHasher.hash(password);

    const result = await passwordHasher.verify(
      password,
      hash,
    );

    expect(result).toBe(true);
  });

  it("should reject an incorrect password", async () => {
    const hash = await passwordHasher.hash(password);

    const result = await passwordHasher.verify(
      "Wrong-Password-123!",
      hash,
    );

    expect(result).toBe(false);
  });

  it("should reject an unsupported hash format", async () => {
    const result = await passwordHasher.verify(
      password,
      "not-a-valid-password-hash",
    );

    expect(result).toBe(false);
  });

  it("should reject empty passwords", async () => {
    await expect(
      passwordHasher.hash(""),
    ).rejects.toThrow("Password cannot be empty.");

    await expect(
      passwordHasher.verify("", "$argon2id$invalid"),
    ).rejects.toThrow("Password cannot be empty.");
  });
});