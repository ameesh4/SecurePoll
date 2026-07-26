import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { elections } from "./elections";
import { voters } from "./voters";

/**
 * Marks a vetted voter as entitled to vote in one election. Because registration is global,
 * this is where the per-election electorate is decided; the presence of a row is the
 * entitlement and revoking it means deleting the row.
 *
 * Both foreign keys are ON DELETE RESTRICT. An election that has an electorate is history
 * and should be moved to CANCELLED rather than deleted, and a voter who appears in any
 * electorate cannot be erased.
 */
export const electionEligibility = pgTable(
  "election_eligibility",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    electionId: uuid("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "restrict" }),
    voterId: uuid("voter_id")
      .notNull()
      .references(() => voters.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Also the target of the composite foreign key from ring_members, which is what stops
    // an ineligible voter being placed into a ring.
    uniqueIndex("election_eligibility_election_voter_unique").on(
      t.electionId,
      t.voterId,
    ),
    index("election_eligibility_voter_idx").on(t.voterId),
  ],
);

export type ElectionEligibility = typeof electionEligibility.$inferSelect;
export type NewElectionEligibility = typeof electionEligibility.$inferInsert;
