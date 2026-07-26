export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Outbound mail. Approval and rejection must not depend on delivery succeeding — the
 * decision is already committed — so callers treat send failures as logged, not fatal.
 */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}
