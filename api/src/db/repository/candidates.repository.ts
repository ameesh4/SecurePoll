import { and, asc, eq, max, sql } from "drizzle-orm";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import { candidates, type Candidate, type NewCandidate } from "../schema";

export async function createCandidate(
  values: NewCandidate,
  executor: Executor = db,
): Promise<Candidate> {
  const rows = await executor.insert(candidates).values(values).returning();
  const created = rows[0];
  if (!created) throw new Error("Failed to create candidate");
  return created;
}

export async function findCandidateById(
  id: string,
  executor: Executor = db,
): Promise<Candidate | undefined> {
  const rows = await executor
    .select()
    .from(candidates)
    .where(eq(candidates.id, id))
    .limit(1);
  return rows[0];
}

/** Ordered as they appear on the ballot: by office, then by position within it. */
export async function listCandidates(
  electionId: string,
  executor: Executor = db,
): Promise<Candidate[]> {
  return executor
    .select()
    .from(candidates)
    .where(eq(candidates.electionId, electionId))
    .orderBy(asc(candidates.office), asc(candidates.ballotPosition));
}

export async function updateCandidate(
  id: string,
  values: Partial<NewCandidate>,
  executor: Executor = db,
): Promise<Candidate> {
  const rows = await executor
    .update(candidates)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(candidates.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) throw new Error("Failed to update candidate");
  return updated;
}

export async function deleteCandidate(id: string, executor: Executor = db): Promise<void> {
  await executor.delete(candidates).where(eq(candidates.id, id));
}

/** Next free ballot slot in an office, so callers can append without picking a number. */
export async function nextBallotPosition(
  electionId: string,
  office: string,
  executor: Executor = db,
): Promise<number> {
  const rows = await executor
    .select({ value: max(candidates.ballotPosition) })
    .from(candidates)
    .where(and(eq(candidates.electionId, electionId), eq(candidates.office, office)));
  return (rows[0]?.value ?? 0) + 1;
}

export interface OfficeTally {
  office: string;
  candidates: number;
}

/**
 * Candidate count per contested office.
 *
 * This is what the "at least two candidates per office" guard is decided on. An office with
 * one name on it is not an election, it is an appointment, and letting voting open on one
 * would put a result in the ledger that nobody chose.
 */
export async function countCandidatesByOffice(
  electionId: string,
  executor: Executor = db,
): Promise<OfficeTally[]> {
  const rows = await executor
    .select({ office: candidates.office, value: sql<number>`count(*)::int` })
    .from(candidates)
    .where(eq(candidates.electionId, electionId))
    .groupBy(candidates.office)
    .orderBy(asc(candidates.office));

  return rows.map((row) => ({ office: row.office, candidates: row.value }));
}
