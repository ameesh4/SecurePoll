import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { registrationStatus } from "./enums";
import { voters } from "./voters";

/**
 * The public intake table. `POST /api/register` writes here and nowhere else, so every row
 * is unvetted, self-asserted data from an unauthenticated caller. Treat it accordingly.
 *
 * Registration is global rather than per-election: a person registers once, and an admin
 * approving them creates their `voters` row. Eligibility for a particular election is a
 * separate decision recorded in `election_eligibility`.
 *
 * The identity columns are duplicated from `voters` on purpose. They are the *claim* as
 * submitted, preserved verbatim, which is what an auditor needs to see when reviewing why
 * a voter was admitted or turned away. The `voters` row is the *accepted* version.
 */
export const registrations = pgTable(
  "registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    fullName: text("full_name").notNull(),
    nationalId: text("national_id").notNull(),
    email: text("email").notNull(),
    /** 32-byte compressed ristretto255 point, base64url encoded. */
    publicKey: text("public_key").notNull(),

    status: registrationStatus("status").notNull().default("PENDING"),
    rejectionReason: text("rejection_reason"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** Set when and only when the registration is approved. */
    voterId: uuid("voter_id").references(() => voters.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Uniqueness deliberately excludes rejected rows. A hard unique index here would let
    // anyone permanently lock a real person out of the system by registering their
    // national id first: the squatted row would survive its own rejection and keep
    // blocking the genuine submission. Excluding rejected rows means a rejection actually
    // releases the claim, while still preventing duplicate live registrations.
    uniqueIndex("registrations_national_id_live_unique")
      .on(t.nationalId)
      .where(sql`${t.status} <> 'REJECTED'`),
    uniqueIndex("registrations_email_live_unique")
      .on(t.email)
      .where(sql`${t.status} <> 'REJECTED'`),
    uniqueIndex("registrations_public_key_live_unique")
      .on(t.publicKey)
      .where(sql`${t.status} <> 'REJECTED'`),

    // Backs the admin review queue, which is read newest-first filtered by status.
    index("registrations_status_created_idx").on(t.status, t.createdAt),

    check(
      "registrations_rejection_reason_required",
      sql`${t.status} <> 'REJECTED' or ${t.rejectionReason} is not null`,
    ),
    // A voter row exists if and only if this registration was approved.
    check(
      "registrations_voter_link_matches_status",
      sql`(${t.status} = 'APPROVED') = (${t.voterId} is not null)`,
    ),
    check(
      "registrations_reviewed_at_matches_status",
      sql`(${t.status} = 'PENDING') = (${t.reviewedAt} is null)`,
    ),
  ],
);

export type Registration = typeof registrations.$inferSelect;
export type NewRegistration = typeof registrations.$inferInsert;
