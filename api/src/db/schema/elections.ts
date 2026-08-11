import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { electionStatus } from "./enums";

export const elections = pgTable(
  "elections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description"),
    status: electionStatus("status").notNull().default("DRAFT"),

    registrationOpensAt: timestamp("registration_opens_at", { withTimezone: true }),
    /**
     * When registration is advertised as closing. Informational: the actual close is an admin
     * transitioning the election, because closing fixes the candidate list and freezes the
     * electorate, and neither should happen on a timer while nobody is watching.
     */
    registrationClosesAt: timestamp("registration_closes_at", { withTimezone: true }),
    votingOpensAt: timestamp("voting_opens_at", { withTimezone: true }),
    votingClosesAt: timestamp("voting_closes_at", { withTimezone: true }),

    /** Target members per LRS ring for this election. */
    ringSize: integer("ring_size").notNull().default(10),

    /**
     * Root node of this election's ledger network. Each election runs its own separate
     * blockchain, so the address belongs to the election rather than to global config. Null
     * until an operator records one; the in-memory stub stands in until then.
     */
    chainRootIp: text("chain_root_ip"),
    chainRootPort: integer("chain_root_port"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A ring of size 1 is a signature with the voter's name on it. The real minimum is a
    // configurable policy value (default 10) checked at ring-formation time; this is the
    // absolute floor below which the scheme is meaningless.
    check("elections_ring_size_min", sql`${t.ringSize} >= 2`),
    check(
      "elections_chain_root_port_range",
      sql`${t.chainRootPort} is null or (${t.chainRootPort} > 0 and ${t.chainRootPort} <= 65535)`,
    ),
    check(
      "elections_voting_window_valid",
      sql`${t.votingOpensAt} is null or ${t.votingClosesAt} is null or ${t.votingClosesAt} > ${t.votingOpensAt}`,
    ),
  ],
);

export type Election = typeof elections.$inferSelect;
export type NewElection = typeof elections.$inferInsert;
