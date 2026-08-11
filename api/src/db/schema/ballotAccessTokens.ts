import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { elections } from "./elections";
import { electionEligibility } from "./eligibility";
import { emailDeliveryStatus } from "./enums";
import { voters } from "./voters";

/**
 * The `Token` model from the project context — a bearer credential emailed to an
 * approved voter. Named for what it authorises, because what it authorises is narrower than
 * "token" suggests and the narrowness is the point.
 *
 * It authenticates exactly one request: "give me the public keys of the ring I am in". It is
 * consumed there and is *never* presented alongside a ballot. The proposal's original flow
 * submitted `vote + signature + token` to the ledger; because this server knows
 * `token -> voter`, that would have let anyone holding both sides de-anonymise every ballot.
 * The ring signature authorises casting, the key image prevents double voting, and this row
 * only ever authorises retrieval.
 *
 * Consequences visible in the columns below:
 *
 *  - Only `tokenHash` is stored. The token itself exists in the outbound email and nowhere
 *    else; a database dump cannot be used to fetch anybody's ring.
 *  - `redeemedAt` records *that* the credential was spent, never what followed. There is
 *    deliberately no column linking a voter to a key image or a ballot — such a column
 *    would single-handedly undo the whole scheme.
 */
export const ballotAccessTokens = pgTable(
  "ballot_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    electionId: uuid("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "restrict" }),
    voterId: uuid("voter_id")
      .notNull()
      .references(() => voters.id, { onDelete: "restrict" }),

    /**
     * SHA-256 of the base64url token, hex encoded. A plain hash rather than a password KDF
     * is correct here: the input is 32 bytes of CSPRNG output, so there is no dictionary to
     * attack and nothing for a slow hash to buy.
     */
    tokenHash: text("token_hash").notNull(),

    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    /** Defaults to the election's close at issue time. Past this the token is inert. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set the first and only time the token is spent. Single use is enforced on this. */
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),

    emailStatus: emailDeliveryStatus("email_status").notNull().default("PENDING"),
    /**
     * Snapshot of the address the credential was sent to. Kept separate from `voters.email`
     * so that correcting a bounced address is visible as a change rather than rewriting
     * history, and so the dispatch log still shows where an earlier attempt went.
     */
    deliverTo: text("deliver_to").notNull(),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** Transport-level reason for the most recent failure, e.g. "SMTP 421". */
    lastError: text("last_error"),

    /**
     * Fixed-window counter behind the per-recipient resend limit, kept on the row rather
     * than in a separate attempt-history table.
     *
     * The limit is what stops "resend" being a way to mail-bomb one voter: an admin who
     * clicks it repeatedly, or a script that does, is refused rather than served. A fixed
     * window is coarser than a sliding one — a caller can spend the whole allowance at the
     * end of one window and again at the start of the next — which is acceptable for a
     * courtesy re-send and avoids storing a row per email attempt.
     */
    resendWindowStartedAt: timestamp("resend_window_started_at", { withTimezone: true }),
    resendsInWindow: integer("resends_in_window").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One credential per voter per election. Resending re-delivers this row rather than
    // minting a second one, so a voter can never hold two valid tokens at once.
    uniqueIndex("ballot_access_tokens_election_voter_unique").on(t.electionId, t.voterId),
    uniqueIndex("ballot_access_tokens_hash_unique").on(t.tokenHash),

    // A credential may only exist for a voter in this election's electorate, and that
    // eligibility cannot be revoked while the credential still stands.
    foreignKey({
      name: "ballot_access_tokens_eligibility_fk",
      columns: [t.electionId, t.voterId],
      foreignColumns: [electionEligibility.electionId, electionEligibility.voterId],
    }).onDelete("restrict"),

    // Backs the dispatch queue view, which reads one election filtered by delivery state.
    index("ballot_access_tokens_dispatch_idx").on(t.electionId, t.emailStatus),

    check("ballot_access_tokens_expiry_after_issue", sql`${t.expiresAt} > ${t.issuedAt}`),
    check(
      "ballot_access_tokens_attempts_non_negative",
      sql`${t.deliveryAttempts} >= 0 and ${t.resendsInWindow} >= 0`,
    ),
    // A token cannot have been spent before it was issued.
    check(
      "ballot_access_tokens_redeemed_after_issue",
      sql`${t.redeemedAt} is null or ${t.redeemedAt} >= ${t.issuedAt}`,
    ),
    // Nothing can have been delivered without an attempt having been made.
    check(
      "ballot_access_tokens_status_needs_attempt",
      sql`${t.emailStatus} = 'PENDING' or ${t.deliveryAttempts} > 0`,
    ),
  ],
);

export type BallotAccessToken = typeof ballotAccessTokens.$inferSelect;
export type NewBallotAccessToken = typeof ballotAccessTokens.$inferInsert;
