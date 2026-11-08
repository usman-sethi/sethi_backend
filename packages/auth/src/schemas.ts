import { z } from "zod";

const passwordSchema = z
  .string()
  .min(15, "Password must contain at least 15 characters.")
  .max(1024, "Password must not exceed 1024 characters.");

export const registrationSchema = z
  .object({
    email: z
      .string()
      .trim()
      .pipe(z.email())
      .transform((email) => email.toLowerCase()),
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .pipe(z.email())
      .transform((email) => email.toLowerCase()),
    password: z.string().min(1).max(1024),
  })
  .strict();

export const emailInputSchema = z
  .object({
    email: z
      .string()
      .trim()
      .pipe(z.email())
      .transform((email) => email.toLowerCase()),
  })
  .strict();

export const verificationTokenSchema = z
  .object({
    token: z.string().min(1).max(512),
  })
  .strict();

export const passwordResetSchema = z
  .object({
    token: z.string().min(1).max(512),
    newPassword: passwordSchema,
  })
  .strict();

export type RegistrationInput = z.output<typeof registrationSchema>;
export type LoginInput = z.output<typeof loginSchema>;
export type EmailInput = z.output<typeof emailInputSchema>;
export type PasswordResetInput = z.output<typeof passwordResetSchema>;
