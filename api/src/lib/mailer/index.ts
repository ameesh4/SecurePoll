import { env } from "../../config/env";
import { ConsoleMailer } from "./console";
import { SmtpMailer } from "./smtp";
import type { Mailer } from "./types";

export type { EmailMessage, Mailer } from "./types";

/**
 * SMTP (nodemailer) in normal environments. The console implementation is for tests so
 * they never open a real connection.
 */
export function createMailer(): Mailer {
  if (env.NODE_ENV === "test") return new ConsoleMailer();
  return new SmtpMailer();
}

export const mailer = createMailer();
