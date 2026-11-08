import { z } from "zod";

/**
 * Represents environment variables provided by Node.js
 * or another configuration source.
 */
export type ConfigSource = Readonly<
  Record<string, string | undefined>
>;

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * Loads, validates and transforms configuration.
 *
 * The schema determines the final output type.
 */
export function loadConfig<TSchema extends z.ZodType>(
  schema: TSchema,
  source: ConfigSource,
): z.output<TSchema> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const field =
          issue.path.length > 0
            ? issue.path.map(String).join(".")
            : "configuration";

        return `- ${field}: ${issue.message}`;
      })
      .join("\n");

    throw new ConfigValidationError(
      `Configuration validation failed:\n${details}`,
    );
  }

  return result.data;
}