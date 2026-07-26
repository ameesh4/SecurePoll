import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(5011),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /**
   * Admin sessions are signed with this. A short secret is a forgeable admin session, and
   * an admin session can enfranchise voters, so the length floor is deliberate.
   */
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(7200),
  /** Comma-separated list of origins allowed to call the API. */
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  SMTP_HOST: z.string().min(1, "SMTP_HOST is required"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  /** When true, use TLS from the first hop (typically port 465). */
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
  SMTP_USER: z.string().min(1, "SMTP_USER is required"),
  SMTP_PASS: z.string().min(1, "SMTP_PASS is required"),
  /** Displayed From header, e.g. `Secure Poll <noreply@example.com>`. */
  SMTP_FROM: z.string().min(3, "SMTP_FROM is required"),

  /**
   * Smallest anonymity group that may be published. A ring of one is a signature with the
   * voter's name on it, and a ring of three is not much better; the floor of 10 is the
   * policy value the project settled on. Ring formation refuses to publish below it.
   */
  RING_MIN_SIZE: z.coerce.number().int().min(2).default(10),

  /** Origin of the voter-facing app, used to build ballot-access links in emails. */
  VOTER_APP_BASE_URL: z.string().min(1).default("http://localhost:5173"),

  /**
   * Per-recipient resend allowance. Deliberately small: re-sending is a courtesy for a voter
   * whose mail did not arrive, not a bulk operation, and an unbounded resend button is a way
   * to flood one person's inbox.
   */
  TOKEN_RESEND_MAX: z.coerce.number().int().min(1).default(3),
  TOKEN_RESEND_WINDOW_MINUTES: z.coerce.number().int().min(1).default(60),

  /** Recipients per dispatch pass, so one batch never blocks the process for long. */
  TOKEN_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;
