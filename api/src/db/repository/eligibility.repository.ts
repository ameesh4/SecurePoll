import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import {
  electionEligibility,
  elections,
  ringMembers,
  rings,
  voters,
  type Election,
  type Voter,
} from "../schema";

export async function grantEligibility(
  electionId: string,
  voterId: string,
  executor: Executor = db,
): Promise<void> {
  // Approving the same voter twice for one election is a harmless repeat, not an error.
  await executor
    .insert(electionEligibility)
    .values({ electionId, voterId })
    .onConflictDoNothing();
}

export async function revokeEligibility(
  electionId: string,
  voterId: string,
  executor: Executor = db,
): Promise<void> {
  await executor
    .delete(electionEligibility)
    .where(
      and(
        eq(electionEligibility.electionId, electionId),
        eq(electionEligibility.voterId, voterId),
      ),
    );
}

export async function isEligible(
  electionId: string,
  voterId: string,
  executor: Executor = db,
): Promise<boolean> {
  const rows = await executor
    .select({ id: electionEligibility.id })
    .from(electionEligibility)
    .where(
      and(
        eq(electionEligibility.electionId, electionId),
        eq(electionEligibility.voterId, voterId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The electorate, ordered by voter id.
 *
 * Ordering is by id rather than by name or approval time on purpose: ring formation shuffles
 * this list, and a shuffle of a list ordered by *when someone was approved* leaks that
 * ordering into ring membership if the shuffle is ever weak or reproduced. An arbitrary,
 * identity-independent order gives the shuffle nothing to leak.
 */
export async function listEligibleVoters(
  electionId: string,
  executor: Executor = db,
): Promise<Voter[]> {
  const rows = await executor
    .select({ voter: voters })
    .from(electionEligibility)
    .innerJoin(voters, eq(voters.id, electionEligibility.voterId))
    .where(eq(electionEligibility.electionId, electionId))
    .orderBy(asc(voters.id));

  return rows.map((row) => row.voter);
}

/**
 * The most recent election a voter was enfranchised for, with that election's row.
 *
 * Registration is global but a voter's status page has to talk about a specific election
 * ("voting opens 30 July"), and the newest roll they were added to is the one they are asking
 * about. Returns undefined for a voter on no roll — a legitimate state, not an error.
 */
export async function findLatestEligibility(
  voterId: string,
  executor: Executor = db,
): Promise<{ election: Election } | undefined> {
  const rows = await executor
    .select({ election: elections })
    .from(electionEligibility)
    .innerJoin(elections, eq(elections.id, electionEligibility.electionId))
    .where(eq(electionEligibility.voterId, voterId))
    .orderBy(desc(electionEligibility.createdAt))
    .limit(1);
  return rows[0];
}

export interface EligibleVoterRow {
  voter: Voter;
  /** 0-based index of the voter's ring within the election, or null if not yet assigned. */
  ringIndex: number | null;
}

export interface VoterListQuery {
  electionId: string;
  search?: string;
  page: number;
  pageSize: number;
}

/**
 * Paginated electorate with each voter's ring, for the admin voters list.
 *
 * The ring index is shown so an admin can confirm that everybody landed somewhere. It is
 * safe to display: which anonymity group a voter belongs to is published to the ledger
 * anyway — that is the whole mechanism. What must never appear beside it is anything about
 * how or whether they voted, and no such column exists to join.
 */
export async function listElectorate(
  query: VoterListQuery,
  executor: Executor = db,
): Promise<{ rows: EligibleVoterRow[]; total: number }> {
  const filters = [eq(electionEligibility.electionId, query.electionId)];
  if (query.search) {
    const term = `%${query.search}%`;
    const matches = or(
      ilike(voters.fullName, term),
      ilike(voters.email, term),
      ilike(voters.nationalId, term),
    );
    if (matches) filters.push(matches);
  }
  const where = and(...filters);

  // The unique index on (electionId, voterId) in ring_members guarantees the left join adds
  // at most one row per voter, so this cannot inflate the page.
  const [rows, counted] = await Promise.all([
    executor
      .select({ voter: voters, ringIndex: rings.index })
      .from(electionEligibility)
      .innerJoin(voters, eq(voters.id, electionEligibility.voterId))
      .leftJoin(
        ringMembers,
        and(
          eq(ringMembers.electionId, electionEligibility.electionId),
          eq(ringMembers.voterId, electionEligibility.voterId),
        ),
      )
      .leftJoin(rings, eq(rings.id, ringMembers.ringId))
      .where(where)
      .orderBy(asc(voters.fullName))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    executor
      .select({ value: count() })
      .from(electionEligibility)
      .innerJoin(voters, eq(voters.id, electionEligibility.voterId))
      .where(where),
  ]);

  return {
    rows: rows.map((row) => ({ voter: row.voter, ringIndex: row.ringIndex })),
    total: Number(counted[0]?.value ?? 0),
  };
}

/**
 * Grants eligibility to many voters at once.
 *
 * `onConflictDoNothing` makes this idempotent, and the returned rows are the ones that were
 * actually inserted — so the caller can tell "added 340" from "340 were already on the roll"
 * rather than reporting a number that includes no-ops.
 */
export async function grantEligibilityMany(
  electionId: string,
  voterIds: readonly string[],
  executor: Executor = db,
): Promise<string[]> {
  if (voterIds.length === 0) return [];
  const inserted = await executor
    .insert(electionEligibility)
    .values(voterIds.map((voterId) => ({ electionId, voterId })))
    .onConflictDoNothing()
    .returning({ voterId: electionEligibility.voterId });
  return inserted.map((row) => row.voterId);
}

export interface AvailableVoterRow {
  voter: Voter;
  /** How many other elections this voter has been on the roll for. Context, not a filter. */
  pastElections: number;
}

/**
 * Vetted voters who are **not** on this election's roll.
 *
 * This is the pool for bulk transfer. It reads from `voters` rather than `registrations` on
 * purpose: everyone here has already been vetted by a person and had a `voters` row minted for
 * them, so adding them to a new election is an enrolment decision, not a fresh identity check.
 * Nobody enters this list without having passed the queue once.
 *
 * Two joins onto the same table, hence the aliases: one to exclude anybody already enrolled
 * here, one to count their other enrolments.
 */
export async function listVotersNotOnRoll(
  query: VoterListQuery,
  executor: Executor = db,
): Promise<{ rows: AvailableVoterRow[]; total: number }> {
  const enrolledHere = alias(electionEligibility, "enrolled_here");
  const enrolledAnywhere = alias(electionEligibility, "enrolled_anywhere");

  const filters = [isNull(enrolledHere.id)];
  if (query.search) {
    const term = `%${query.search}%`;
    const matches = or(
      ilike(voters.fullName, term),
      ilike(voters.email, term),
      ilike(voters.nationalId, term),
    );
    if (matches) filters.push(matches);
  }
  const where = and(...filters);

  const [rows, counted] = await Promise.all([
    executor
      .select({
        voter: voters,
        // Counted over the aliased join rather than a correlated subquery, so there is no bare
        // column name that could bind to the wrong table.
        pastElections: sql<number>`count(distinct ${enrolledAnywhere.electionId})::int`,
      })
      .from(voters)
      .leftJoin(
        enrolledHere,
        and(
          eq(enrolledHere.voterId, voters.id),
          eq(enrolledHere.electionId, query.electionId),
        ),
      )
      .leftJoin(enrolledAnywhere, eq(enrolledAnywhere.voterId, voters.id))
      .where(where)
      .groupBy(voters.id)
      .orderBy(asc(voters.fullName))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    executor
      .select({ value: count() })
      .from(voters)
      .leftJoin(
        enrolledHere,
        and(
          eq(enrolledHere.voterId, voters.id),
          eq(enrolledHere.electionId, query.electionId),
        ),
      )
      .where(where),
  ]);

  return {
    rows: rows.map((row) => ({ voter: row.voter, pastElections: row.pastElections })),
    total: Number(counted[0]?.value ?? 0),
  };
}

/** Voters on this roll who are already in a ring, so their enrolment can no longer be undone. */
export async function votersLockedIntoRings(
  electionId: string,
  voterIds: readonly string[],
  executor: Executor = db,
): Promise<Set<string>> {
  if (voterIds.length === 0) return new Set();
  const rows = await executor
    .select({ voterId: ringMembers.voterId })
    .from(ringMembers)
    .where(
      and(
        eq(ringMembers.electionId, electionId),
        inArray(ringMembers.voterId, [...voterIds]),
      ),
    );
  return new Set(rows.map((row) => row.voterId));
}

/**
 * Every election a voter is enrolled in, with the election row.
 *
 * Used to decide whether replacing their key can still do anything: a ring already published holds
 * a snapshot of the old key, so rotation is safe for those elections but cannot help with them.
 */
export async function listEligibilityWithElections(
  voterId: string,
  executor: Executor = db,
): Promise<{ election: Election }[]> {
  return executor
    .select({ election: elections })
    .from(electionEligibility)
    .innerJoin(elections, eq(elections.id, electionEligibility.electionId))
    .where(eq(electionEligibility.voterId, voterId))
    .orderBy(desc(electionEligibility.createdAt));
}
