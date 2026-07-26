import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * A vetted person. Rows are created only by an admin approving a row in `registrations` —
 * nothing reaches this table straight off the wire, so unlike the intake table these
 * uniqueness rules can be unconditional.
 *
 * Only the public half of the voter's keypair is stored. The private key is generated on
 * the voter's device and must never reach this server in any form.
 *
 * `publicKey` is mutable in principle (key rotation after a lost device), which is exactly
 * why `ring_members` snapshots the key rather than joining back to this row.
 */
export const voters = pgTable(
  "voters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    nationalId: text("national_id").notNull(),
    /** Stored lowercase; normalise before insert so the unique index is meaningful. */
    email: text("email").notNull(),
    /** 32-byte compressed ristretto255 point, base64url encoded. */
    publicKey: text("public_key").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("voters_national_id_unique").on(t.nationalId),
    uniqueIndex("voters_email_unique").on(t.email),
    // Two voters sharing a public key would collide on key image and one of them could
    // never cast a countable vote.
    uniqueIndex("voters_public_key_unique").on(t.publicKey),
  ],
);

export type Voter = typeof voters.$inferSelect;
export type NewVoter = typeof voters.$inferInsert;
