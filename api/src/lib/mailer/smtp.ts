import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { env } from "../../config/env";
import type { EmailMessage, Mailer } from "./types";

export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter<SMTPTransport.SentMessageInfo>;

  constructor() {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: env.SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
