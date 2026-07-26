import { and, asc, count, desc, eq } from "drizzle-orm";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import {
  keyRotationRequests,
  registrations,
  voters,
  type KeyRotationRequest,
  type NewKeyRotationRequest,
  type Registration,
  type Voter,
} from "../schema";

export async function createRotationRequest(
  values: NewKeyRotationRequest,
  executor: Executor = db,
): Promise<KeyRotationRequest> {
  const rows = await executor.insert(keyRotationRequests).values(values).returning();
  const created = rows[0];
  if (!created) throw new Error("Failed to create key rotation request");
  return created;
}

export async function findRotationRequestById(
  id: string,
  executor: Executor = db,
): Promise<KeyRotationRequest | undefined> {
  const rows = await executor
    .select()
    .from(keyRotationRequests)
    .where(eq(keyRotationRequests.id, id))
    .limit(1);
  return rows[0];
}

/**
 * Locks the request for the surrounding transaction, so two admins reviewing the same request
 * cannot both act on it — one approving while the other rejects would leave the key state
 * depending on which transaction committed last.
 */
export async function lockRotationRequestById(
  id: string,
  executor: Executor,
): Promise<KeyRotationRequest | undefined> {
  const rows = await executor
    .select()
    .from(keyRotationRequests)
    .where(eq(keyRotationRequests.id, id))
    .limit(1)
    .for("update");
  return rows[0];
}

export async function findPendingRotationForVoter(
  voterId: string,
  executor: Executor = db,
): Promise<KeyRotationRequest | undefined> {
  const rows = await executor
    .select()
    .from(keyRotationRequests)
    .where(
      and(
        eq(keyRotationRequests.voterId, voterId),
        eq(keyRotationRequests.status, "PENDING"),
      ),
    )
    .limit(1);
  return rows[0];
}

export interface RotationRequestRow {
  request: KeyRotationRequest;
  voter: Voter;
  registration: Registration;
}

/** Requests awaiting a decision, oldest first — a voter waiting on this cannot vote. */
export async function listPendingRotations(
  params: { page: number; pageSize: number },
  executor: Executor = db,
): Promise<{ rows: RotationRequestRow[]; total: number }> {
  const where = eq(keyRotationRequests.status, "PENDING");

  const [rows, counted] = await Promise.all([
    executor
      .select({
        request: keyRotationRequests,
        voter: voters,
        registration: registrations,
      })
      .from(keyRotationRequests)
      .innerJoin(voters, eq(voters.id, keyRotationRequests.voterId))
      .innerJoin(registrations, eq(registrations.id, keyRotationRequests.registrationId))
      .where(where)
      .orderBy(asc(keyRotationRequests.createdAt))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize),
    executor.select({ value: count() }).from(keyRotationRequests).where(where),
  ]);

  return { rows, total: Number(counted[0]?.value ?? 0) };
}

export async function countPendingRotations(executor: Executor = db): Promise<number> {
  const rows = await executor
    .select({ value: count() })
    .from(keyRotationRequests)
    .where(eq(keyRotationRequests.status, "PENDING"));
  return Number(rows[0]?.value ?? 0);
}

export async function markRotationReviewed(
  id: string,
  outcome: { status: "APPROVED" | "REJECTED"; adminId: string; rejectionReason?: string },
  executor: Executor,
): Promise<KeyRotationRequest> {
  const rows = await executor
    .update(keyRotationRequests)
    .set({
      status: outcome.status,
      rejectionReason: outcome.rejectionReason ?? null,
      reviewedByAdminId: outcome.adminId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    // The status guard makes this safe against a race the lock would otherwise have to catch:
    // no row back means somebody already decided it.
    .where(and(eq(keyRotationRequests.id, id), eq(keyRotationRequests.status, "PENDING")))
    .returning();

  const updated = rows[0];
  if (!updated) throw new Error("This request has already been reviewed");
  return updated;
}

/** A voter's rotation history, newest first, for the audit trail on their record. */
export async function listRotationsForVoter(
  voterId: string,
  executor: Executor = db,
): Promise<KeyRotationRequest[]> {
  return executor
    .select()
    .from(keyRotationRequests)
    .where(eq(keyRotationRequests.voterId, voterId))
    .orderBy(desc(keyRotationRequests.createdAt));
}
