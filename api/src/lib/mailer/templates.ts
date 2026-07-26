import type { EmailMessage } from "../mailer/types";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Matches the interface: ink #201e1d on paper #f3f2f2, ochre accent, square corners. */
const INK = "#201e1d";
const ACCENT = "#a8690f";
const MUTED = "#6b6867";

function wrap(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
  <body style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.55; color: ${INK}; max-width: 560px; margin: 0 auto; padding: 24px;">
    <p style="font-size: 11px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: ${ACCENT}; margin: 0 0 16px;">Secure Poll</p>
    ${bodyHtml}
    <p style="margin-top: 28px; font-size: 12px; color: ${MUTED};">This message was sent by the Secure Poll verification server. Do not reply to this address.</p>
  </body>
</html>`;
}

function formatWhen(value: Date): string {
  return value.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function registrationApprovedEmail(input: {
  fullName: string;
  to: string;
}): EmailMessage {
  const name = escapeHtml(input.fullName);
  return {
    to: input.to,
    subject: "Your Secure Poll registration was approved",
    text: [
      `Hello ${input.fullName},`,
      "",
      "Your voter registration has been approved. You are now on the electoral roll.",
      "Keep the private key you saved at registration — you will need it to cast a ballot.",
      "We will contact you again when voting opens.",
      "",
      "— Secure Poll",
    ].join("\n"),
    html: wrap(`
      <h1 style="font-size: 20px; margin: 0 0 12px;">Registration approved</h1>
      <p>Hello ${name},</p>
      <p>Your voter registration has been approved. You are now on the electoral roll.</p>
      <p>Keep the private key you saved at registration — you will need it to cast a ballot. We will contact you again when voting opens.</p>
    `),
  };
}

export function registrationRejectedEmail(input: {
  fullName: string;
  to: string;
  reason: string;
}): EmailMessage {
  const name = escapeHtml(input.fullName);
  const reason = escapeHtml(input.reason);
  return {
    to: input.to,
    subject: "Your Secure Poll registration was not approved",
    text: [
      `Hello ${input.fullName},`,
      "",
      "Your voter registration was not approved.",
      "",
      `Reason: ${input.reason}`,
      "",
      "If you believe this was a mistake, you may submit a new registration once the issue is resolved.",
      "",
      "— Secure Poll",
    ].join("\n"),
    html: wrap(`
      <h1 style="font-size: 20px; margin: 0 0 12px;">Registration not approved</h1>
      <p>Hello ${name},</p>
      <p>Your voter registration was not approved.</p>
      <p style="padding: 12px 14px; background: #faf4e8; border-left: 3px solid ${ACCENT};"><strong>Reason:</strong> ${reason}</p>
      <p>If you believe this was a mistake, you may submit a new registration once the issue is resolved.</p>
    `),
  };
}

/**
 * The ballot-access email. This message is the only place the plaintext credential ever
 * exists — the server keeps a hash, so it cannot re-read or re-send this link, only replace it.
 *
 * The copy avoids "token", "ring" and "signature" entirely. A voter does not need the
 * vocabulary of the scheme to use it correctly, and telling them their "LSAG ring token" is
 * enclosed communicates nothing except that the message might be a scam.
 */
export function ballotAccessEmail(input: {
  to: string;
  fullName: string;
  electionTitle: string;
  ballotUrl: string;
  expiresAt: Date;
}): EmailMessage {
  const name = escapeHtml(input.fullName);
  const title = escapeHtml(input.electionTitle);
  const url = escapeHtml(input.ballotUrl);
  const expires = formatWhen(input.expiresAt);

  return {
    to: input.to,
    subject: `Your ballot for ${input.electionTitle}`,
    text: [
      `Hello ${input.fullName},`,
      "",
      `Voting is open for ${input.electionTitle}. Use the link below to collect your ballot:`,
      "",
      input.ballotUrl,
      "",
      `The link works once and expires at ${expires}.`,
      "",
      "You will need the voting key you saved when you registered. Nobody, including the",
      "election office, holds a copy of it.",
      "",
      "This link identifies you to the election office only in order to hand you a ballot.",
      "How you vote is never recorded against your name.",
      "",
      "— Secure Poll",
    ].join("\n"),
    html: wrap(`
      <h1 style="font-size: 20px; margin: 0 0 12px;">Your ballot is ready</h1>
      <p>Hello ${name},</p>
      <p>Voting is open for <strong>${title}</strong>.</p>
      <p style="margin: 20px 0;">
        <a href="${url}" style="display: inline-block; background: ${ACCENT}; color: #f3f2f2; font-weight: 700; text-decoration: none; padding: 12px 18px;">Collect your ballot</a>
      </p>
      <p style="font-size: 13px; color: ${MUTED};">The link works once and expires at ${expires}.</p>
      <p>You will need the voting key you saved when you registered. Nobody — including the election office — holds a copy of it.</p>
      <p style="font-size: 13px; color: ${MUTED};">This link identifies you to the election office only in order to hand you a ballot. How you vote is never recorded against your name.</p>
    `),
  };
}

/**
 * Confirmation that a key replacement was filed.
 *
 * Sent to the address on the voter's record — which matters, because the request could have been
 * filed by somebody who got hold of their registration link. If that happens, this email is how the
 * real voter finds out, so it says plainly what to do about it.
 */
export function keyReplacementRequestedEmail(input: {
  to: string;
  fullName: string;
  statusUrl: string | null;
}): EmailMessage {
  const name = escapeHtml(input.fullName);
  return {
    to: input.to,
    subject: "A new voting key was requested for your registration",
    text: [
      `Hello ${input.fullName},`,
      "",
      "Somebody asked to replace the voting key on your voter registration. An election officer",
      "will review the request, and we will email you the outcome.",
      "",
      "If this was not you, contact an election officer now. Until the request is approved your",
      "existing key is unchanged.",
      "",
      "— Secure Poll",
    ].join("\n"),
    html: wrap(`
      <h1 style="font-size: 20px; margin: 0 0 12px;">A new voting key was requested</h1>
      <p>Hello ${name},</p>
      <p>Somebody asked to replace the voting key on your voter registration. An election officer will review the request, and we will email you the outcome.</p>
      <p style="padding: 12px 14px; background: #faf4e8; border-left: 3px solid ${ACCENT};"><strong>If this was not you</strong>, contact an election officer now. Until the request is approved, your existing key is unchanged.</p>
    `),
  };
}

export function keyReplacementApprovedEmail(input: {
  to: string;
  fullName: string;
}): EmailMessage {
  const name = escapeHtml(input.fullName);
  return {
    to: input.to,
    subject: "Your new voting key is active",
    text: [
      `Hello ${input.fullName},`,
      "",
      "Your new voting key has been approved and is now the key on your record. Use the key file",
      "you saved when you created it — the old one no longer works.",
      "",
      "Nobody, including the election office, holds a copy of it.",
      "",
      "— Secure Poll",
    ].join("\n"),
    html: wrap(`
      <h1 style="font-size: 20px; margin: 0 0 12px;">Your new voting key is active</h1>
      <p>Hello ${name},</p>
      <p>Your new voting key has been approved and is now the key on your record. Use the key file you saved when you created it — the old one no longer works.</p>
      <p style="font-size: 13px; color: ${MUTED};">Nobody, including the election office, holds a copy of it.</p>
    `),
  };
}

export function keyReplacementRejectedEmail(input: {
  to: string;
  fullName: string;
  reason: string;
}): EmailMessage {
  const name = escapeHtml(input.fullName);
  const reason = escapeHtml(input.reason);
  return {
    to: input.to,
    subject: "Your voting key was not replaced",
    text: [
      `Hello ${input.fullName},`,
      "",
      "An election officer did not approve the request to replace your voting key.",
      "",
      `Reason: ${input.reason}`,
      "",
      "Your existing key is unchanged. If you still cannot open your key file, speak to an",
      "election officer.",
      "",
      "— Secure Poll",
    ].join("\n"),
    html: wrap(`
      <h1 style="font-size: 20px; margin: 0 0 12px;">Your voting key was not replaced</h1>
      <p>Hello ${name},</p>
      <p>An election officer did not approve the request to replace your voting key.</p>
      <p style="padding: 12px 14px; background: #faf4e8; border-left: 3px solid ${ACCENT};"><strong>Reason:</strong> ${reason}</p>
      <p>Your existing key is unchanged. If you still cannot open your key file, speak to an election officer.</p>
    `),
  };
}
