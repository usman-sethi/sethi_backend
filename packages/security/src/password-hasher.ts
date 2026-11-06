import * as argon2 from "argon2";

/**
 * Initial Argon2id configuration.
 *
 * memoryCost is measured in KiB.
 */
const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
};

/**
 * Public password hashing contract.
 */
export interface PasswordHasher {
  /**
   * Converts a plaintext password into an encoded hash.
   */
  hash(password: string): Promise<string>;

  /**
   * Checks a submitted password against an encoded hash.
   */
  verify(
    password: string,
    encodedHash: string,
  ): Promise<boolean>;
}

/**
 * Validate password input without modifying it.
 *
 * We deliberately do not trim or lowercase passwords.
 * Leading spaces, trailing spaces and letter case matter.
 */
function assertPassword(
  password: unknown,
): asserts password is string {
  if (typeof password !== "string") {
    throw new TypeError("Password must be a string.");
  }

  if (password.length === 0) {
    throw new RangeError("Password cannot be empty.");
  }
}

/**
 * Create an Argon2id password hasher.
 */
export function createPasswordHasher(): PasswordHasher {
  return {
    async hash(password: string): Promise<string> {
      assertPassword(password);

      return argon2.hash(password, ARGON2_OPTIONS);
    },

    async verify(
      password: string,
      encodedHash: string,
    ): Promise<boolean> {
      assertPassword(password);

      // Reject unsupported or obviously invalid formats.
      if (
        typeof encodedHash !== "string" ||
        !encodedHash.startsWith("$argon2id$")
      ) {
        return false;
      }

      return argon2.verify(encodedHash, password);
    },
  };
}