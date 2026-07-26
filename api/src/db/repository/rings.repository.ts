import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import {
  ringMembers,
  rings,
  type NewRing,
  type NewRingMember,
  type Ring,
  type RingMember,
} from "../schema";

export async function listRings(
  electionId: string,
  executor: Executor = db,
): Promise<Ring[]> {
  return executor
    .select()
    .from(rings)
    .where(eq(rings.electionId, electionId))
    .orderBy(asc(rings.index));
}

export async function findRingById(
  id: string,
  executor: Executor = db,
): Promise<Ring | undefined> {
  const rows = await executor.select().from(rings).where(eq(rings.id, id)).limit(1);
  return rows[0];
}

export async function insertRings(
  values: readonly NewRing[],
  executor: Executor,
): Promise<Ring[]> {
  if (values.length === 0) return [];
  return executor.insert(rings).values([...values]).returning();
}

export async function insertRingMembers(
  values: readonly NewRingMember[],
  executor: Executor,
): Promise<void> {
  if (values.length === 0) return;
  await executor.insert(ringMembers).values([...values]);
}

/**
 * Deletes every ring for an election, cascading to its members.
 *
 * Only ever called to re-form rings that have not been published. The caller must have
 * checked that no ring carries a `publishedAt`, because a published ring's membership is
 * what already-cast signatures verify against — removing it does not "undo" a publication,
 * it strands every ballot made against it. That check lives in the service so this function
 * stays a plain delete, but it is not optional.
 */
export async function deleteUnpublishedRings(
  electionId: string,
  executor: Executor,
): Promise<void> {
  await executor
    .delete(rings)
    .where(and(eq(rings.electionId, electionId), isNull(rings.publishedAt)));
}

export async function markRingPublished(
  ringId: string,
  chainTxRef: string,
  executor: Executor,
): Promise<Ring> {
  const rows = await executor
    .update(rings)
    .set({ publishedAt: new Date(), chainTxRef })
    .where(and(eq(rings.id, ringId), isNull(rings.publishedAt)))
    .returning();

  const updated = rows[0];
  // The `isNull` in the where clause makes this idempotent-safe rather than silently
  // re-publishing: no row back means it was already published and the caller raced.
  if (!updated) throw new Error("Ring was already published");
  return updated;
}

export interface RingWithSize {
  ring: Ring;
  size: number;
}

/** Rings with their member counts, which is what the formation preview renders. */
export async function listRingsWithSizes(
  electionId: string,
  executor: Executor = db,
): Promise<RingWithSize[]> {
  const rows = await executor
    .select({
      ring: rings,
      size: sql<number>`count(${ringMembers.id})::int`,
    })
    .from(rings)
    .leftJoin(ringMembers, eq(ringMembers.ringId, rings.id))
    .where(eq(rings.electionId, electionId))
    .groupBy(rings.id)
    .orderBy(asc(rings.index));

  return rows.map((row) => ({ ring: row.ring, size: row.size }));
}

/** Members of one ring, in the order the signature scheme depends on. */
export async function listRingMembers(
  ringId: string,
  executor: Executor = db,
): Promise<RingMember[]> {
  return executor
    .select()
    .from(ringMembers)
    .where(eq(ringMembers.ringId, ringId))
    .orderBy(asc(ringMembers.positionInRing));
}

/** The ring a given voter belongs to in an election, if any. */
export async function findRingForVoter(
  electionId: string,
  voterId: string,
  executor: Executor = db,
): Promise<Ring | undefined> {
  const rows = await executor
    .select({ ring: rings })
    .from(ringMembers)
    .innerJoin(rings, eq(rings.id, ringMembers.ringId))
    .where(
      and(eq(ringMembers.electionId, electionId), eq(ringMembers.voterId, voterId)),
    )
    .limit(1);
  return rows[0]?.ring;
}

/** Smallest ring in the election, or null when it has no rings. */
export async function smallestRingSize(
  electionId: string,
  executor: Executor = db,
): Promise<number | null> {
  const sizes = await listRingsWithSizes(electionId, executor);
  if (sizes.length === 0) return null;
  return Math.min(...sizes.map((entry) => entry.size));
}

export async function countRings(
  electionId: string,
  options: { publishedOnly?: boolean } = {},
  executor: Executor = db,
): Promise<number> {
  const where = options.publishedOnly
    ? and(eq(rings.electionId, electionId), isNotNull(rings.publishedAt))
    : eq(rings.electionId, electionId);

  const rows = await executor.select({ value: count() }).from(rings).where(where);
  return Number(rows[0]?.value ?? 0);
}
