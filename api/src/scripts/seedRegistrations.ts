import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { bytesToNumberLE, numberToBytesLE } from "@noble/curves/utils.js";
import { db } from "../db/drizzle";
import {
  createRegistration,
  markRegistrationApproved,
} from "../db/repository/registrations.repository";
import { createVoter } from "../db/repository/voters.repository";

/**
 * Seeds already-approved registrations for local development, so there is an electorate to
 * test eligibility, ring formation, and voting against without clicking through the review
 * queue by hand.
 *
 * Each seeded row goes straight to APPROVED: a registration and its voter are created inside
 * one transaction, mirroring what `approveRegistration` does for a real review, because the
 * `registrations_voter_link_matches_status` check requires the two to appear together.
 *
 * The private key never touches the database — same rule as a real registration — so each
 * one is written to `api/seed-keys/<registration-id>.key` instead. That file uses the same
 * `private_key:` / `public_key:` line format the web app's `parseKeyFile` reads, so it can be
 * renamed to `.securepoll` and imported straight into the app to vote as that seeded voter.
 *
 * Usage: bun run db:seed-registrations [count]
 */

const RPoint = ristretto255.Point;
const GROUP_ORDER = RPoint.Fn.ORDER;

const KEY_OUTPUT_DIR = path.join(import.meta.dirname, "..", "..", "seed-keys");

const FIRST_NAMES = [
  "Aiko",
  "Ben",
  "Chidi",
  "Dara",
  "Elena",
  "Farid",
  "Grace",
  "Hana",
  "Ivan",
  "Jyoti",
  "Kwame",
  "Lucia",
];

const LAST_NAMES = [
  "Adeyemi",
  "Bianchi",
  "Chen",
  "Dubois",
  "Eriksson",
  "Farrell",
  "Gupta",
  "Haruna",
  "Ivanova",
  "Jensen",
  "Kaur",
  "Lindqvist",
];

function randomScalar(): bigint {
  const scalar = bytesToNumberLE(randomBytes(64)) % GROUP_ORDER;
  return scalar === 0n ? 1n : scalar;
}

function generateVoterKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const scalar = randomScalar();
  return {
    privateKey: numberToBytesLE(scalar, 32),
    publicKey: RPoint.BASE.multiply(scalar).toBytes(),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomFrom<T>(pool: T[]): T {
  const item = pool[randomBytes(1)[0]! % pool.length];
  if (item === undefined) throw new Error("pool must not be empty");
  return item;
}

function randomDigits(length: number): string {
  let digits = "";
  for (const byte of randomBytes(length)) {
    digits += (byte % 10).toString();
  }
  return digits;
}

function keyFileContents(
  registrationId: string,
  voterId: string,
  fullName: string,
  privateKey: string,
  publicKey: string,
): string {
  return [
    "SecurePoll voting key — seeded for local development. Do not use in production.",
    "",
    `full_name:        ${fullName}`,
    `registration_id:  ${registrationId}`,
    `voter_id:         ${voterId}`,
    `private_key:      ${privateKey}`,
    `public_key:       ${publicKey}`,
    "",
  ].join("\n");
}

async function seedOne(): Promise<{ registrationId: string; voterId: string; fullName: string }> {
  const fullName = `${randomFrom(FIRST_NAMES)} ${randomFrom(LAST_NAMES)}`;
  const nationalId = randomDigits(12);
  const email = `voter-${randomDigits(8)}@example.test`;
  const { privateKey, publicKey } = generateVoterKeypair();
  const publicKeyEncoded = toBase64Url(publicKey);

  const { registrationId, voterId } = await db.transaction(async (tx) => {
    const registration = await createRegistration(
      { fullName, nationalId, email, publicKey: publicKeyEncoded },
      tx,
    );
    const voter = await createVoter(
      { fullName, nationalId, email, publicKey: publicKeyEncoded },
      tx,
    );
    await markRegistrationApproved(registration.id, voter.id, tx);
    return { registrationId: registration.id, voterId: voter.id };
  });

  writeFileSync(
    path.join(KEY_OUTPUT_DIR, `${email}.key`),
    keyFileContents(registrationId, voterId, fullName, toBase64Url(privateKey), publicKeyEncoded),
    { mode: 0o600 },
  );

  return { registrationId, voterId, fullName };
}

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 10);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Usage: bun run db:seed-registrations [count]");
  }

  mkdirSync(KEY_OUTPUT_DIR, { recursive: true });

  for (let i = 0; i < count; i += 1) {
    const seeded = await seedOne();
    console.log(`Approved ${seeded.fullName} — registration ${seeded.registrationId}`);
  }

  console.log(`\nSeeded ${count} approved registration(s). Private keys written to ${KEY_OUTPUT_DIR}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
