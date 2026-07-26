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
import { admins } from "./admins";
import { keyRotationStatus } from "./enums";
import { registrations } from "./registrations";
import { voters } from "./voters";

/**
 * A voter's request to replace the voting key on their record, after losing the private half.
 *
 * This table exists because of one asymmetry: only the voter can generate a keypair — the private
 * half never reaches this server — so a replacement has to be *initiated* by them. But letting
 * them apply it unilaterally would be a real weakening of the system, and the reason is worth
 * spelling out.
 *
 * The only thing authenticating a voter here is possession of their registration link, which
 * arrives by email. The ballot-access link arrives by the same email. So today an attacker holding
 * that inbox can collect a ballot link but cannot sign anything with it — the worst they achieve
 * is denying the real voter their vote. If they could also swap in a public key they hold, they
 * could cast that person's ballot. Self-service replacement would turn a denial-of-service into
 * vote theft.
 *
 * Hence the split, implemented in the service:
 *
 *  - A registration still **awaiting review** has nothing to protect. No voter record exists, no
 *    ring contains the key, and an admin is going to inspect the record anyway. The new key is
 *    written straight onto the registration and no row is created here.
 *  - An **approved** voter files a request, which an admin must approve. That keeps the project's
 *    stated authentication model — manual vetting by a person — in the one place where the
 *    consequence of getting it wrong is somebody else's vote.
 *
 * Note what is absent: no column holds a private key, a seed, or a mnemonic, and none may ever be
 * added. `newPublicKey` is the public half and nothing else.
 */
export const keyRotationRequests = pgTable(
  "key_rotation_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The registration the voter followed the link from. Their proof of who is asking. */
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => registrations.id, { onDelete: "restrict" }),
    voterId: uuid("voter_id")
      .notNull()
      .references(() => voters.id, { onDelete: "restrict" }),

    /** 32-byte compressed ristretto255 point, base64url. Public half only. */
    newPublicKey: text("new_public_key").notNull(),
    /**
     * The key being replaced, copied at request time.
     *
     * Snapshotted rather than read from `voters` when the request is reviewed, so the audit trail
     * shows what was actually swapped even if the record moves on in between.
     */
    previousPublicKey: text("previous_public_key").notNull(),

    status: keyRotationStatus("status").notNull().default("PENDING"),
    /** Why the voter says they need a new key. Free text, shown to the reviewing admin. */
    reason: text("reason"),
    rejectionReason: text("rejection_reason"),

    reviewedByAdminId: uuid("reviewed_by_admin_id").references(() => admins.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One open request per voter. Without this, a voter (or somebody with their link) could queue
    // up a dozen candidate keys and leave an admin guessing which is genuine.
    uniqueIndex("key_rotation_requests_one_pending_per_voter")
      .on(t.voterId)
      .where(sql`${t.status} = 'PENDING'`),

    index("key_rotation_requests_status_created_idx").on(t.status, t.createdAt),
    index("key_rotation_requests_voter_idx").on(t.voterId),

    check(
      "key_rotation_requests_rejection_reason_required",
      sql`${t.status} <> 'REJECTED' or ${t.rejectionReason} is not null`,
    ),
    check(
      "key_rotation_requests_review_matches_status",
      sql`(${t.status} = 'PENDING') = (${t.reviewedAt} is null)`,
    ),
    // Replacing a key with itself is a no-op that would still consume a review.
    check(
      "key_rotation_requests_key_actually_changes",
      sql`${t.newPublicKey} <> ${t.previousPublicKey}`,
    ),
  ],
);

export type KeyRotationRequest = typeof keyRotationRequests.$inferSelect;
export type NewKeyRotationRequest = typeof keyRotationRequests.$inferInsert;
