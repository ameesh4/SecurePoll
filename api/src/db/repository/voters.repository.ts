import { eq, or, sql } from "drizzle-orm";
import {
  NO_CONFLICTS,
  type ConflictFields,
  type IdentityClaim,
} from "../../lib/conflicts";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import { voters, type NewVoter, type Voter } from "../schema";

export async function createVoter(values: NewVoter, executor: Executor = db): Promise<Voter> {
  const rows = await executor.insert(voters).values(values).returning();
  const created = rows[0];
  if (!created) throw new Error("Failed to create voter");
  return created;
}

export async function findVoterById(
  id: string,
  executor: Executor = db,
): Promise<Voter | undefined> {
  const rows = await executor.select().from(voters).where(eq(voters.id, id)).limit(1);
  return rows[0];
}

function claimMatches(claim: IdentityClaim) {
  return or(
    eq(voters.nationalId, claim.nationalId),
    eq(voters.email, claim.email),
    eq(voters.publicKey, claim.publicKey),
  );
}

/**
 * Existing vetted voters colliding with a claim, as whole rows. A hit means the person (or
 * their key) is already enfranchised.
 *
 * For the admin review screen. The public registration path wants
 * `findConflictingVoterFields` instead.
 */
export async function findVoterConflicts(
  claim: IdentityClaim,
  executor: Executor = db,
): Promise<Voter[]> {
  return executor.select().from(voters).where(claimMatches(claim));
}

/** As above, but resolved in the database to three booleans. */
export async function findConflictingVoterFields(
  claim: IdentityClaim,
  executor: Executor = db,
): Promise<ConflictFields> {
  const rows = await executor
    .select({
      nationalId: sql<boolean>`coalesce(bool_or(${voters.nationalId} = ${claim.nationalId}), false)`,
      email: sql<boolean>`coalesce(bool_or(${voters.email} = ${claim.email}), false)`,
      publicKey: sql<boolean>`coalesce(bool_or(${voters.publicKey} = ${claim.publicKey}), false)`,
    })
    .from(voters)
    .where(claimMatches(claim));

  return rows[0] ?? NO_CONFLICTS;
}

/**
 * Replaces a voter's public key.
 *
 * Safe with respect to already-published rings, and only because `ring_members` snapshots the key
 * rather than joining back to this row: a ring published last month keeps the key it was published
 * with, so every signature already made against it still verifies. The new key takes effect for
 * rings formed from now on.
 *
 * The unique index on `voters.public_key` is the real guard against two voters sharing a key — two
 * voters with one key would collide on key image, and one of them could never cast a countable
 * ballot.
 */
export async function updateVoterPublicKey(
  voterId: string,
  publicKey: string,
  executor: Executor = db,
): Promise<Voter> {
  const rows = await executor
    .update(voters)
    .set({ publicKey, updatedAt: new Date() })
    .where(eq(voters.id, voterId))
    .returning();
  const updated = rows[0];
  if (!updated) throw new Error("Failed to update voter public key");
  return updated;
}
