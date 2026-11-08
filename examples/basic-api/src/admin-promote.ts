import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  createMongoDatabaseAdapter,
  createMongoAuthUserRepository,
} from "@sethi-backend/database-mongodb";
import { loadAppConfig } from "./config.js";

function getEmailArgument(args: readonly string[]): string {
  const index = args.indexOf("--email");
  const email = index >= 0 ? args[index + 1] : undefined;
  if (!email || email.startsWith("--")) {
    throw new Error("Provide an email with --email.");
  }
  return email.trim().toLowerCase();
}

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Administrator promotion requires an interactive terminal.");
  }
  const email = getEmailArgument(process.argv.slice(2));
  const config = loadAppConfig();
  const database = createMongoDatabaseAdapter({
    uri: config.mongodb.uri,
    databaseName: config.mongodb.databaseName,
  });
  const users = createMongoAuthUserRepository({
    getDatabase: () => database.getDatabase(),
    getClient: () => database.getClient(),
  });

  try {
    await database.connect();
    await users.ensureIndexes();
    const user = await users.findByEmail(email);
    if (!user) {
      throw new Error("No account was found for the specified email.");
    }
    if (!user.emailVerified) {
      throw new Error("The account must verify its email before promotion.");
    }

    const prompt = createInterface({ input: stdin, output: stdout });
    let confirmation: string;
    try {
      confirmation = await prompt.question(
        `To promote ${email} to administrator, type the email exactly: `,
      );
    } finally {
      prompt.close();
    }
    if (confirmation !== email) {
      throw new Error("Email confirmation did not match; no role was changed.");
    }

    const result = await users.setRole(user.id, "admin", new Date(), null);
    if (result.status === "updated" || result.status === "unchanged") {
      stdout.write(
        result.status === "updated"
          ? "Administrator role assigned and audit record written.\n"
          : "The account is already an administrator.\n",
      );
      return;
    }
    throw new Error(`Administrator promotion was not completed (${result.status}).`);
  } finally {
    await database.disconnect();
  }
}

await main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  console.error(`Administrator promotion failed (${errorName}).`);
  process.exitCode = 1;
});
