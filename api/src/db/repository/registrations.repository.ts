import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import {
  NO_CONFLICTS,
  type ConflictFields,
  type IdentityClaim,
} from "../../lib/conflicts";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import {
  registrations,
  voters,
  type NewRegistration,
  type Registration,
  type RegistrationStatus,
} from "../schema";

/** A registration still holding its claim on a national id / email / public key. */
const isLive = ne(registrations.status, "REJECTED");

export async function createRegistration(
  values: NewRegistration,
  executor: Executor = db,
): Promise<Registration> {
  const rows = await executor.insert(registrations).values(values).returning();
  const created = rows[0];
  if (!created) throw new Error("Failed to create registration");
  return created;
}

export async function findRegistrationById(
  id: string,
  executor: Executor = db,
): Promise<Registration | undefined> {
  const rows = await executor
    .select()
    .from(registrations)
    .where(eq(registrations.id, id))
    .limit(1);
  return rows[0];
}

/**
 * Locks the row for the duration of the surrounding transaction so two admins reviewing the
 * same registration cannot both act on it.
 */
export async function lockRegistrationById(
  id: string,
  executor: Executor,
): Promise<Registration | undefined> {
  const rows = await executor
    .select()
    .from(registrations)
    .where(eq(registrations.id, id))
    .limit(1)
    .for("update");
  return rows[0];
}

function claimMatches(claim: IdentityClaim) {
  return or(
    eq(registrations.nationalId, claim.nationalId),
    eq(registrations.email, claim.email),
    eq(registrations.publicKey, claim.publicKey),
  );
}

/**
 * Live registrations already claiming any of these identifiers, as whole rows.
 *
 * For the admin review screen, which names the conflicting applicant. The public
 * registration path wants `findConflictingFields` instead — it only needs to know which
 * field collided, and has no business pulling other people's identifiers into memory.
 */
export async function findLiveConflicts(
  claim: IdentityClaim,
  options: { excludeId?: string } = {},
  executor: Executor = db,
): Promise<Registration[]> {
  const matches = claimMatches(claim);
  const where = options.excludeId
    ? and(isLive, matches, ne(registrations.id, options.excludeId))
    : and(isLive, matches);

  return executor.select().from(registrations).where(where);
}

/**
 * Which of the three identifiers are already spoken for by a live registration.
 *
 * `bool_or` over an empty set is null rather than false, hence the coalesce.
 */
export async function findConflictingFields(
  claim: IdentityClaim,
  executor: Executor = db,
): Promise<ConflictFields> {
  const rows = await executor
    .select({
      nationalId: sql<boolean>`coalesce(bool_or(${registrations.nationalId} = ${claim.nationalId}), false)`,
      email: sql<boolean>`coalesce(bool_or(${registrations.email} = ${claim.email}), false)`,
      publicKey: sql<boolean>`coalesce(bool_or(${registrations.publicKey} = ${claim.publicKey}), false)`,
    })
    .from(registrations)
    .where(and(isLive, claimMatches(claim)));

  return rows[0] ?? NO_CONFLICTS;
}

export interface RegistrationListQuery {
  status?: RegistrationStatus;
  search?: string;
  /** Restrict to records whose identifiers collide with another live record or a voter. */
  flaggedOnly?: boolean;
  page: number;
  pageSize: number;
}

/**
 * Whether this registration's identifiers collide with anything already in the system.
 *
 * Computed in SQL as part of the list query rather than by fetching each record's detail. That
 * is not only a performance choice: the queue's bulk-approve is offered *only* for a selection
 * with no flags, so the flag has to be a fact the list itself carries. Deciding it per-row in
 * the browser would mean the safety of a 200-record bulk action rested on 200 extra requests
 * having all completed.
 *
 * Each identifier is checked against both live registrations and vetted voters, which are the
 * two places a claim can already be spoken for.
 *
 * The voter check excludes the registration's *own* voter row. Approving a registration mints a
 * voter carrying the same national id, email and public key, so without that exclusion every
 * approved record would report itself as a triple duplicate of the identity it created — and the
 * "Flagged" filter would list the entire approved electorate.
 */
/**
 * Outer-row column reference, written out fully qualified.
 *
 * This qualification is load-bearing, not stylistic. Drizzle renders a column placeholder as a
 * bare `"national_id"`, and inside a correlated subquery like `select 1 from voters v` a bare
 * name binds to the *inner* table — so `v.national_id = "national_id"` silently becomes
 * `v.national_id = v.national_id`, which is always true, and every record reports as a
 * duplicate. Naming the outer table explicitly is what keeps the correlation real.
 */
function outer(column: "id" | "national_id" | "email" | "public_key" | "voter_id") {
  return sql.raw(`"registrations"."${column}"`);
}

/**
 * Whether this registration's identifier collides with anything already in the system.
 *
 * Computed in SQL as part of the list query rather than by fetching each record's detail. That
 * is not only a performance choice: the queue's bulk-approve is offered *only* for a selection
 * with no flags, so the flag has to be a fact the list itself carries. Deciding it per-row in
 * the browser would mean the safety of a 200-record bulk action rested on 200 extra requests
 * having all completed.
 *
 * Each identifier is checked against both live registrations and vetted voters, which are the
 * two places a claim can already be spoken for.
 *
 * The voter check excludes the registration's *own* voter row. Approving a registration mints a
 * voter carrying the same national id, email and public key, so without that exclusion every
 * approved record would report itself as a triple duplicate of the identity it created.
 */
function duplicateOn(column: "national_id" | "email" | "public_key") {
  return sql<boolean>`(
    exists (select 1 from "registrations" other
            where other.id <> ${outer("id")}
              and other.status <> 'REJECTED'
              and other.${sql.raw(column)} = ${outer(column)})
    or exists (select 1 from "voters" v
               where v.${sql.raw(column)} = ${outer(column)}
                 and (${outer("voter_id")} is null or v.id <> ${outer("voter_id")}))
  )`;
}

const duplicateFlag = {
  nationalId: duplicateOn("national_id"),
  email: duplicateOn("email"),
  publicKey: duplicateOn("public_key"),
};

const anyDuplicateFlag = sql<boolean>`(${duplicateFlag.nationalId} or ${duplicateFlag.email} or ${duplicateFlag.publicKey})`;

export interface RegistrationListRow extends Registration {
  /** Which identifiers collide. Empty when the record is clean. */
  duplicateFields: ("nationalId" | "email" | "publicKey")[];
}

export async function listRegistrations(
  query: RegistrationListQuery,
  executor: Executor = db,
): Promise<{ rows: RegistrationListRow[]; total: number }> {
  const filters = [];
  if (query.status) filters.push(eq(registrations.status, query.status));
  if (query.search) {
    const term = `%${query.search}%`;
    const matches = or(
      ilike(registrations.fullName, term),
      ilike(registrations.email, term),
      ilike(registrations.nationalId, term),
    );
    if (matches) filters.push(matches);
  }
  if (query.flaggedOnly) filters.push(anyDuplicateFlag);
  const where = filters.length ? and(...filters) : undefined;

  const [rows, counted] = await Promise.all([
    executor
      .select({
        registration: registrations,
        dupNationalId: duplicateFlag.nationalId,
        dupEmail: duplicateFlag.email,
        dupPublicKey: duplicateFlag.publicKey,
      })
      .from(registrations)
      .where(where)
      .orderBy(desc(registrations.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    executor
      .select({ value: sql<number>`count(*)::int` })
      .from(registrations)
      .where(where),
  ]);

  return {
    rows: rows.map((row) => {
      const duplicateFields: RegistrationListRow["duplicateFields"] = [];
      if (row.dupNationalId) duplicateFields.push("nationalId");
      if (row.dupEmail) duplicateFields.push("email");
      if (row.dupPublicKey) duplicateFields.push("publicKey");
      return { ...row.registration, duplicateFields };
    }),
    total: counted[0]?.value ?? 0,
  };
}

/** How many pending records carry a duplicate flag, for the queue's "Flagged" filter. */
export async function countFlaggedPending(executor: Executor = db): Promise<number> {
  const rows = await executor
    .select({ value: sql<number>`count(*)::int` })
    .from(registrations)
    .where(and(eq(registrations.status, "PENDING"), anyDuplicateFlag));
  return rows[0]?.value ?? 0;
}

export async function markRegistrationApproved(
  id: string,
  voterId: string,
  executor: Executor,
): Promise<Registration> {
  const rows = await executor
    .update(registrations)
    .set({
      status: "APPROVED",
      voterId,
      reviewedAt: new Date(),
      rejectionReason: null,
      updatedAt: new Date(),
    })
    .where(eq(registrations.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) throw new Error("Failed to approve registration");
  return updated;
}

export async function markRegistrationRejected(
  id: string,
  reason: string,
  executor: Executor,
): Promise<Registration> {
  const rows = await executor
    .update(registrations)
    .set({
      status: "REJECTED",
      rejectionReason: reason,
      reviewedAt: new Date(),
      voterId: null,
      updatedAt: new Date(),
    })
    .where(eq(registrations.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) throw new Error("Failed to reject registration");
  return updated;
}

export async function countByStatus(
  executor: Executor = db,
): Promise<Record<RegistrationStatus, number>> {
  const rows = await executor
    .select({ status: registrations.status, value: sql<number>`count(*)::int` })
    .from(registrations)
    .groupBy(registrations.status);

  const totals: Record<RegistrationStatus, number> = {
    PENDING: 0,
    APPROVED: 0,
    REJECTED: 0,
  };
  for (const row of rows) totals[row.status] = row.value;
  return totals;
}

/**
 * Replaces the public key on a registration that is still awaiting review.
 *
 * Only ever called for a PENDING row. The registration table is otherwise the claim *as
 * submitted*, preserved verbatim for an auditor — but a row nobody has looked at yet has no
 * decision attached to it, so correcting the key on it rewrites nothing that mattered. Once
 * approved, the key moves under the `voters` row and this function stops being the right one.
 */
export async function updateRegistrationPublicKey(
  id: string,
  publicKey: string,
  executor: Executor,
): Promise<Registration> {
  const rows = await executor
    .update(registrations)
    .set({ publicKey, updatedAt: new Date() })
    .where(and(eq(registrations.id, id), eq(registrations.status, "PENDING")))
    .returning();
  const updated = rows[0];
  if (!updated) throw new Error("Registration is no longer awaiting review");
  return updated;
}
