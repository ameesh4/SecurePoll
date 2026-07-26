import { sql } from "drizzle-orm";
import {
  check,
  index,
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
 * `office` is an addition to the data model sketched in the project context, which carried
 * only a flat ballot `position`. The election being modelled fills several seats at once
 * (President, Treasurer, …) and the guard for opening voting is "at least two candidates
 * *per seat*" — a flat list cannot express that, and an uncontested seat would otherwise
 * slip through. Ballot position is then ordering *within* an office.
 */
export const candidates = pgTable(
  "candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    electionId: uuid("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "restrict" }),

    /** The seat being contested, e.g. "President". Free text: the set differs per election. */
    office: text("office").notNull(),
    name: text("name").notNull(),
    /** Party, panel, or "Independent". Null when the election does not use affiliations. */
    affiliation: text("affiliation"),
    photoUrl: text("photo_url"),
    /** Order on the printed ballot within `office`, 1-based. */
    ballotPosition: integer("ballot_position").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Two candidates cannot share a slot on the same ballot section.
    uniqueIndex("candidates_office_position_unique").on(
      t.electionId,
      t.office,
      t.ballotPosition,
    ),
    // Backs the grouped-by-office read that both the ballot and the pre-flight guard use.
    index("candidates_election_office_idx").on(t.electionId, t.office),
    check("candidates_ballot_position_positive", sql`${t.ballotPosition} >= 1`),
  ],
);

export type Candidate = typeof candidates.$inferSelect;
export type NewCandidate = typeof candidates.$inferInsert;
