import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { electionEligibility } from "./eligibility";
import { elections } from "./elections";

/**
 * An LRS group: the set of public keys a ballot is signed on behalf of. Called a "ring" in
 * the LSAG literature and in the rest of this codebase.
 *
 * Once `publishedAt` is set the ring is frozen. Adding or removing a member after that
 * point invalidates signatures already made against it, so membership changes must be
 * refused at the service layer for published rings.
 */
export const rings = pgTable(
  "rings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    electionId: uuid("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "restrict" }),
    /** Position of this ring within its election, 0-based. */
    index: integer("index").notNull(),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** Reference returned by the chain adapter when the ring was published. */
    chainTxRef: text("chain_tx_ref"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rings_election_index_unique").on(t.electionId, t.index),
    // Redundant against the primary key, but it gives `ring_members` something to point a
    // composite foreign key at. See the note on ring_members.electionId.
    uniqueIndex("rings_id_election_unique").on(t.id, t.electionId),
    check("rings_index_non_negative", sql`${t.index} >= 0`),
  ],
);

/**
 * Membership of a voter in a ring. Order matters: the ring is an ordered list of public
 * keys and a signature is verified against that exact ordering, so `positionInRing` is
 * part of the cryptographic contract, not presentation.
 */
export const ringMembers = pgTable(
  "ring_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ringId: uuid("ring_id").notNull(),
    /**
     * Denormalised from `rings` so the database can enforce "a voter belongs to at most one
     * ring per election" with a single unique index, and so membership can be tied back to
     * the electorate. Both composite foreign keys below keep this copy honest.
     */
    electionId: uuid("election_id").notNull(),
    voterId: uuid("voter_id").notNull(),
    positionInRing: integer("position_in_ring").notNull(),
    /**
     * The voter's public key as it stood when the ring was formed, copied rather than
     * joined. The ring published to the chain is a fixed ordered list of key bytes; if this
     * were resolved through `voters.publicKey` at read time, rotating a key would silently
     * rewrite an already-published ring and every signature against it would stop
     * verifying. The snapshot is what makes "frozen" true rather than aspirational.
     */
    publicKey: text("public_key").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Re-forming a ring before publication legitimately deletes and rebuilds it.
    foreignKey({
      name: "ring_members_ring_fk",
      columns: [t.ringId, t.electionId],
      foreignColumns: [rings.id, rings.electionId],
    }).onDelete("cascade"),
    // Only a voter in the election's electorate can be placed in one of its rings, and
    // eligibility cannot be revoked out from under a ring that already contains them.
    foreignKey({
      name: "ring_members_eligibility_fk",
      columns: [t.electionId, t.voterId],
      foreignColumns: [electionEligibility.electionId, electionEligibility.voterId],
    }).onDelete("restrict"),

    uniqueIndex("ring_members_ring_voter_unique").on(t.ringId, t.voterId),
    uniqueIndex("ring_members_ring_position_unique").on(t.ringId, t.positionInRing),
    uniqueIndex("ring_members_election_voter_unique").on(t.electionId, t.voterId),
    // A repeated key inside one ring collapses the anonymity set and breaks verification.
    uniqueIndex("ring_members_ring_public_key_unique").on(t.ringId, t.publicKey),
    check("ring_members_position_non_negative", sql`${t.positionInRing} >= 0`),
  ],
);

export type Ring = typeof rings.$inferSelect;
export type NewRing = typeof rings.$inferInsert;
export type RingMember = typeof ringMembers.$inferSelect;
export type NewRingMember = typeof ringMembers.$inferInsert;
