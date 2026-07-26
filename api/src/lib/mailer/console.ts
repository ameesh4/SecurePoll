import type { EmailMessage, Mailer } from "./types";

/** Dev fallback that prints to stdout instead of hitting the network. */
export class ConsoleMailer implements Mailer {
  async send(message: EmailMessage): Promise<void> {
    console.log(
      [
        "[mailer] console delivery",
        `  to:      ${message.to}`,
        `  subject: ${message.subject}`,
        "  ---",
        message.text,
      ].join("\n"),
    );
  }
}
