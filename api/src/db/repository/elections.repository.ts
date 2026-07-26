import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import {
  ballotAccessTokens,
  candidates,
  electionEligibility,
  elections,
  ringMembers,
  rings,
  type Election,
  type ElectionStatus,
  type NewElection,
} from "../schema";

export async function createElection(
  values: NewElection,
  executor: Executor = db,
): Promise<Election> {
  const rows = await executor.insert(elections).values(values).returning();
  const created = rows[0];
  if (!created) throw new Error("Failed to create election");
  return created;
}

export async function findElectionById(
  id: string,
  executor: Executor = db,
): Promise<Election | undefined> {
  const rows = await executor.select().from(elections).where(eq(elections.id, id)).limit(1);
  return rows[0];
}

/**
 * Locks the election row for the surrounding transaction. Every lifecycle transition takes
 * this first: the guards are evaluated by counting candidates, rings and voters, and without
 * the lock two admins could each see passing guards and both advance the state.
 */
export async function lockElectionById(
  id: string,
  executor: Executor,
): Promise<Election | undefined> {
  const rows = await executor
    .select()
    .from(elections)
    .where(eq(elections.id, id))
    .limit(1)
    .for("update");
  return rows[0];
}

export async function updateElection(
  id: string,
  values: Partial<NewElection>,
  executor: Executor = db,
): Promise<Election> {
  const rows = await executor
    .update(elections)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(elections.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) throw new Error("Failed to update election");
  return updated;
}

export async function setElectionStatus(
  id: string,
  status: ElectionStatus,
  executor: Executor,
): Promise<Election> {
  return updateElection(id, { status }, executor);
}

/**
 * Counts that describe an election's progress, gathered in one round-trip per election.
 *
 * These are the same numbers the lifecycle guards are decided on and the same ones the
 * dashboard renders, deliberately read from one place so the screen cannot show a passing
 * pre-flight for a transition the server would refuse.
 */
export interface ElectionCounts {
  electionId: string;
  eligibleVoters: number;
  candidates: number;
  rings: number;
  ringsPublished: number;
  ringMembers: number;
  tokensIssued: number;
  tokensRedeemed: number;
}

const ZERO_COUNTS: Omit<ElectionCounts, "electionId"> = {
  eligibleVoters: 0,
  candidates: 0,
  rings: 0,
  ringsPublished: 0,
  ringMembers: 0,
  tokensIssued: 0,
  tokensRedeemed: 0,
};

export async function countsForElections(
  electionIds: readonly string[],
  executor: Executor = db,
): Promise<Map<string, ElectionCounts>> {
  const result = new Map<string, ElectionCounts>();
  if (electionIds.length === 0) return result;

  const ids = [...electionIds];
  for (const id of ids) result.set(id, { electionId: id, ...ZERO_COUNTS });

  // Five narrow grouped counts rather than one wide join: joining eligibility, candidates,
  // rings and tokens in a single statement multiplies the rows together and every count
  // comes back inflated by the size of the other tables.
  const [eligible, candidateRows, ringRows, memberRows, tokenRows] = await Promise.all([
    executor
      .select({ id: electionEligibility.electionId, value: count() })
      .from(electionEligibility)
      .where(inArray(electionEligibility.electionId, ids))
      .groupBy(electionEligibility.electionId),
    executor
      .select({ id: candidates.electionId, value: count() })
      .from(candidates)
      .where(inArray(candidates.electionId, ids))
      .groupBy(candidates.electionId),
    executor
      .select({
        id: rings.electionId,
        value: count(),
        published: sql<number>`count(${rings.publishedAt})::int`,
      })
      .from(rings)
      .where(inArray(rings.electionId, ids))
      .groupBy(rings.electionId),
    executor
      .select({ id: ringMembers.electionId, value: count() })
      .from(ringMembers)
      .where(inArray(ringMembers.electionId, ids))
      .groupBy(ringMembers.electionId),
    executor
      .select({
        id: ballotAccessTokens.electionId,
        value: count(),
        redeemed: sql<number>`count(${ballotAccessTokens.redeemedAt})::int`,
      })
      .from(ballotAccessTokens)
      .where(inArray(ballotAccessTokens.electionId, ids))
      .groupBy(ballotAccessTokens.electionId),
  ]);

  for (const row of eligible) {
    const entry = result.get(row.id);
    if (entry) entry.eligibleVoters = Number(row.value);
  }
  for (const row of candidateRows) {
    const entry = result.get(row.id);
    if (entry) entry.candidates = Number(row.value);
  }
  for (const row of ringRows) {
    const entry = result.get(row.id);
    if (entry) {
      entry.rings = Number(row.value);
      entry.ringsPublished = Number(row.published);
    }
  }
  for (const row of memberRows) {
    const entry = result.get(row.id);
    if (entry) entry.ringMembers = Number(row.value);
  }
  for (const row of tokenRows) {
    const entry = result.get(row.id);
    if (entry) {
      entry.tokensIssued = Number(row.value);
      entry.tokensRedeemed = Number(row.redeemed);
    }
  }

  return result;
}

export async function countsForElection(
  electionId: string,
  executor: Executor = db,
): Promise<ElectionCounts> {
  const counts = await countsForElections([electionId], executor);
  return counts.get(electionId) ?? { electionId, ...ZERO_COUNTS };
}

export async function listElections(executor: Executor = db): Promise<Election[]> {
  return executor.select().from(elections).orderBy(desc(elections.createdAt));
}

/**
 * Approved voters entitled to vote in this election who are not yet in any ring.
 *
 * Ring formation reads this, and the pre-flight check for freezing requires it to be empty.
 * A voter left out of every ring holds a key that no published ring contains, so their
 * ballot could never verify — they would be silently disenfranchised.
 */
export async function countUnassignedVoters(
  electionId: string,
  executor: Executor = db,
): Promise<number> {
  const rows = await executor
    .select({ value: count() })
    .from(electionEligibility)
    .leftJoin(
      ringMembers,
      and(
        eq(ringMembers.electionId, electionEligibility.electionId),
        eq(ringMembers.voterId, electionEligibility.voterId),
      ),
    )
    .where(and(eq(electionEligibility.electionId, electionId), isNull(ringMembers.id)));

  return Number(rows[0]?.value ?? 0);
}

/** Eligible voters who have no ballot-access credential yet. */
export async function countVotersWithoutToken(
  electionId: string,
  executor: Executor = db,
): Promise<number> {
  const rows = await executor
    .select({ value: count() })
    .from(electionEligibility)
    .leftJoin(
      ballotAccessTokens,
      and(
        eq(ballotAccessTokens.electionId, electionEligibility.electionId),
        eq(ballotAccessTokens.voterId, electionEligibility.voterId),
      ),
    )
    .where(
      and(eq(electionEligibility.electionId, electionId), isNull(ballotAccessTokens.id)),
    );

  return Number(rows[0]?.value ?? 0);
}

export async function countUnpublishedRings(
  electionId: string,
  executor: Executor = db,
): Promise<number> {
  const rows = await executor
    .select({ value: count() })
    .from(rings)
    .where(and(eq(rings.electionId, electionId), isNull(rings.publishedAt)));
  return Number(rows[0]?.value ?? 0);
}

export async function hasPublishedRings(
  electionId: string,
  executor: Executor = db,
): Promise<boolean> {
  const rows = await executor
    .select({ id: rings.id })
    .from(rings)
    .where(and(eq(rings.electionId, electionId), isNotNull(rings.publishedAt)))
    .limit(1);
  return rows.length > 0;
}
