import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { elections } from "./elections";

/**
 * A name on the ballot.
 *
 * `candidates.id` is what a voter's signature commits to — the signed message is the
 * canonical encoding of `{ electionId, ringId, candidateId }` — so a candidate row is part
 * of the cryptographic contract, not merely presentation. Two consequences:
 *
 *  - Ids are never reused and never re-pointed. Correcting a spelling is fine; swapping
 *    which person a row refers to would silently reassign every ballot already cast for it.
 *  - Once rings freeze, the whole set is immutable. Enforced in the service layer against
 *    the election's status, because the rule is "no edits after RINGS_FROZEN" and that
 *    state lives on the parent row.
 *
 * The list is flat, matching the project context's §6.2B. An earlier `office` column grouped
 * candidates into seats, which the scheme cannot support: a voter has one key image per election
 * (`I = x·H_p(P ‖ electionId)`) and the node deduplicates on it, so exactly one ballot carrying
 * exactly one `candidateId` can ever be accepted per voter per election. Several seats would have
 * meant several ballots, and the second would have come back `DOUBLE_VOTE`. One election is one
 * contest; run a separate election per seat.
 */
export const candidates = pgTable(
  "candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    electionId: uuid("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "restrict" }),

    name: text("name").notNull(),
    /** Party, panel, or "Independent". Null when the election does not use affiliations. */
    affiliation: text("affiliation"),
    photoUrl: text("photo_url"),
    /** Order on the ballot, 1-based and unique within the election. */
    ballotPosition: integer("ballot_position").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Two candidates cannot share a slot on the same ballot.
    uniqueIndex("candidates_election_position_unique").on(t.electionId, t.ballotPosition),
    check("candidates_ballot_position_positive", sql`${t.ballotPosition} >= 1`),
  ],
);

export type Candidate = typeof candidates.$inferSelect;
export type NewCandidate = typeof candidates.$inferInsert;
