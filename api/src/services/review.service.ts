import { db } from "../db/drizzle";
import {
  recordAuditEntries,
  recordAuditEntry,
} from "../db/repository/auditLog.repository";
import {
  countByStatus,
  countFlaggedPending,
  findLiveConflicts,
  findRegistrationById,
  listRegistrations,
  lockRegistrationById,
  markRegistrationApproved,
  markRegistrationRejected,
  type RegistrationListQuery,
} from "../db/repository/registrations.repository";
import { lockElectionById } from "../db/repository/elections.repository";
import {
  grantEligibility,
  grantEligibilityMany,
  revokeEligibility,
  votersLockedIntoRings,
} from "../db/repository/eligibility.repository";
import { findRingForVoter } from "../db/repository/rings.repository";
import {
  createVoter,
  findVoterConflicts,
} from "../db/repository/voters.repository";
import { assertOperationAllowed } from "./lifecycle";
import {
  AuditAction,
  type Registration,
  type RegistrationStatus,
  type Voter,
} from "../db/schema";
import { asConflictError } from "../lib/conflicts";
import { ConflictError, NotFoundError } from "../lib/errors";
import { mailer } from "../lib/mailer";
import {
  registrationApprovedEmail,
  registrationRejectedEmail,
} from "../lib/mailer/templates";

/**
 * Delivery must never undo a committed decision. Failures are logged; the admin already
 * got a successful response and the audit log already records the outcome.
 */
function deliver(message: Parameters<typeof mailer.send>[0]): void {
  void mailer.send(message).catch((error: unknown) => {
    console.error(
      "[mailer] failed to deliver:",
      error instanceof Error ? error.message : error,
    );
  });
}

export interface DuplicateWarning {
  field: "nationalId" | "email" | "publicKey";
  against: "registration" | "voter";
  recordId: string;
  detail: string;
}

export interface RegistrationDetail {
  registration: Registration;
  warnings: DuplicateWarning[];
}

export async function getQueue(query: RegistrationListQuery) {
  const [page, totals, flagged] = await Promise.all([
    listRegistrations(query),
    countByStatus(),
    countFlaggedPending(),
  ]);
  return {
    items: page.rows,
    total: page.total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(page.total / query.pageSize)),
    counts: totals,
    /** Pending records whose identifiers collide with something already in the system. */
    flagged,
  };
}

/**
 * The reviewing admin's whole job is deciding whether this person is who they say they are,
 * so the detail view leads with everything that looks like a collision. Unlike the public
 * endpoint this does name the conflicting records — the admin is authenticated and needs
 * them to make the call.
 */
export async function getRegistrationDetail(
  id: string,
): Promise<RegistrationDetail> {
  const registration = await findRegistrationById(id);
  if (!registration) throw new NotFoundError("Registration not found");

  const claim = {
    nationalId: registration.nationalId,
    email: registration.email,
    publicKey: registration.publicKey,
  };

  const [otherRegistrations, voterMatches] = await Promise.all([
    findLiveConflicts(claim, { excludeId: registration.id }),
    findVoterConflicts(claim),
  ]);

  /**
   * The voter this registration *created* is not a conflict with it.
   *
   * Approving mints a voter carrying the same national id, email and public key, so without this
   * filter every approved record would report itself as a triple duplicate of its own identity —
   * and the reviewer would see three red warnings on a record that is perfectly sound.
   */
  const existingVoters = voterMatches.filter((row) => row.id !== registration.voterId);

  const warnings: DuplicateWarning[] = [];

  for (const row of otherRegistrations) {
    if (row.nationalId === claim.nationalId) {
      warnings.push({
        field: "nationalId",
        against: "registration",
        recordId: row.id,
        detail: `Another live registration (${row.fullName}) claims this national id`,
      });
    }
    if (row.email === claim.email) {
      warnings.push({
        field: "email",
        against: "registration",
        recordId: row.id,
        detail: `Another live registration (${row.fullName}) uses this email`,
      });
    }
    if (row.publicKey === claim.publicKey) {
      warnings.push({
        field: "publicKey",
        against: "registration",
        recordId: row.id,
        detail: `Another live registration (${row.fullName}) submitted this exact public key`,
      });
    }
  }

  for (const row of existingVoters) {
    if (row.nationalId === claim.nationalId) {
      warnings.push({
        field: "nationalId",
        against: "voter",
        recordId: row.id,
        detail: `An approved voter (${row.fullName}) already holds this national id`,
      });
    }
    if (row.email === claim.email) {
      warnings.push({
        field: "email",
        against: "voter",
        recordId: row.id,
        detail: `An approved voter (${row.fullName}) already uses this email`,
      });
    }
    if (row.publicKey === claim.publicKey) {
      warnings.push({
        field: "publicKey",
        against: "voter",
        recordId: row.id,
        detail: `An approved voter (${row.fullName}) already holds this public key`,
      });
    }
  }

  return { registration, warnings };
}

function assertPending(registration: Registration): void {
  if (registration.status !== "PENDING") {
    throw new ConflictError(
      `This registration has already been ${registration.status.toLowerCase()}`,
    );
  }
}

function auditSnapshot(registration: Registration) {
  return {
    status: registration.status satisfies RegistrationStatus,
    voterId: registration.voterId,
    rejectionReason: registration.rejectionReason,
  };
}

/**
 * Approval is the moment an unvetted claim becomes an identity that can be placed in a ring,
 * so it runs as one transaction: lock the row, re-check for collisions under that lock,
 * mint the voter, link it, enfranchise them, and write the audit entries. Any failure rolls
 * back all of it.
 *
 * `electionId` is what turns approval into a vote. Registration is global — a person registers
 * once — while entitlement to vote in a particular election is a separate decision recorded in
 * `election_eligibility`. Approving without naming an election creates a vetted voter who is on
 * no electoral roll, which is a legitimate state but almost never what a reviewer working a
 * queue for a named election intends, so the caller passes the election they are reviewing for.
 */
export async function approveRegistration(
  registrationId: string,
  adminId: string,
  options: { electionId?: string } = {},
): Promise<{ registration: Registration; voter: Voter }> {
  const result = await db.transaction(async (tx) => {
    const registration = await lockRegistrationById(registrationId, tx);
    if (!registration) throw new NotFoundError("Registration not found");
    assertPending(registration);

    const claim = {
      nationalId: registration.nationalId,
      email: registration.email,
      publicKey: registration.publicKey,
    };

    // Re-checked inside the transaction rather than trusting what the admin saw on screen,
    // which may be minutes stale.
    const collisions = await findVoterConflicts(claim, tx);
    if (collisions.length > 0) {
      throw new ConflictError(
        "An approved voter already exists with this national id, email, or public key",
        { voterIds: collisions.map((row) => row.id) },
      );
    }

    // The lock above is on the registration, not on `voters`, so two admins approving two
    // different registrations that happen to share an identifier can still collide here.
    // The unique indexes on `voters` decide it; this reports the loser as a conflict.
    let voter: Voter;
    try {
      voter = await createVoter(
        {
          fullName: registration.fullName,
          nationalId: registration.nationalId,
          email: registration.email,
          publicKey: registration.publicKey,
        },
        tx,
      );
    } catch (error) {
      const conflict = asConflictError(
        error,
        "An approved voter already exists with this national id, email, or public key",
      );
      if (conflict) throw conflict;
      throw error;
    }

    const updated = await markRegistrationApproved(
      registration.id,
      voter.id,
      tx,
    );

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.RegistrationApproved,
        entityType: "registration",
        entityId: registration.id,
        electionId: options.electionId ?? null,
        before: auditSnapshot(registration),
        after: { ...auditSnapshot(updated), createdVoterId: voter.id },
      },
      tx,
    );

    if (options.electionId) {
      // Locked, because enfranchising somebody is only legal while registration is open — and
      // that state could be changing under us as another admin closes registration.
      const election = await lockElectionById(options.electionId, tx);
      if (!election) throw new NotFoundError("Election not found");
      assertOperationAllowed("reviewVoters", election);

      await grantEligibility(election.id, voter.id, tx);

      await recordAuditEntry(
        {
          adminId,
          action: AuditAction.EligibilityGranted,
          entityType: "voter",
          entityId: voter.id,
          electionId: election.id,
          before: null,
          after: { electionId: election.id, voterId: voter.id },
        },
        tx,
      );
    }

    return { registration: updated, voter };
  });

  deliver(
    registrationApprovedEmail({
      fullName: result.registration.fullName,
      to: result.registration.email,
    }),
  );

  return result;
}

export async function rejectRegistration(
  registrationId: string,
  adminId: string,
  reason: string,
): Promise<Registration> {
  const updated = await db.transaction(async (tx) => {
    const registration = await lockRegistrationById(registrationId, tx);
    if (!registration) throw new NotFoundError("Registration not found");
    assertPending(registration);

    const rejected = await markRegistrationRejected(
      registration.id,
      reason.trim(),
      tx,
    );

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.RegistrationRejected,
        entityType: "registration",
        entityId: registration.id,
        before: auditSnapshot(registration),
        after: auditSnapshot(rejected),
      },
      tx,
    );

    return rejected;
  });

  deliver(
    registrationRejectedEmail({
      fullName: updated.fullName,
      to: updated.email,
      reason: updated.rejectionReason ?? reason.trim(),
    }),
  );

  return updated;
}

export interface BulkOutcome {
  approved: string[];
  rejected: string[];
  failed: { registrationId: string; reason: string }[];
}

/**
 * Approves many registrations in one request.
 *
 * Each registration is its own transaction rather than all of them sharing one. That is
 * deliberate: these are independent decisions, and a duplicate national id discovered on the
 * fortieth record must not roll back the thirty-nine sound approvals that preceded it. The
 * admin gets back exactly which ones landed and why the rest did not, so the queue can show
 * the failures instead of silently dropping them.
 *
 * Bulk approval is only offered for records with no outstanding duplicate flags — the interface
 * enforces that in the selection, and each individual approval still re-checks collisions under
 * its own lock, so a flagged record slipped into the list is refused here rather than admitted.
 */
export async function approveRegistrations(
  registrationIds: readonly string[],
  adminId: string,
  options: { electionId?: string } = {},
): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { approved: [], rejected: [], failed: [] };

  for (const registrationId of registrationIds) {
    try {
      await approveRegistration(registrationId, adminId, options);
      outcome.approved.push(registrationId);
    } catch (error) {
      outcome.failed.push({
        registrationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcome;
}

export async function rejectRegistrations(
  registrationIds: readonly string[],
  adminId: string,
  reason: string,
): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { approved: [], rejected: [], failed: [] };

  for (const registrationId of registrationIds) {
    try {
      await rejectRegistration(registrationId, adminId, reason);
      outcome.rejected.push(registrationId);
    } catch (error) {
      outcome.failed.push({
        registrationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcome;
}

/**
 * Adds or removes an already-vetted voter from an election's roll, without going back through
 * the registration queue.
 *
 * Revocation is refused once the voter is in a ring. The composite foreign key from
 * `ring_members` to `election_eligibility` would refuse it at the database level anyway; this
 * turns that into an explanation. Removing someone from the roll after their key is published
 * in a ring does not un-publish it — the ring still names them, so the only thing revocation
 * would achieve is a roll that disagrees with the ledger.
 */
export async function setEligibility(
  electionId: string,
  voterId: string,
  eligible: boolean,
  adminId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const election = await lockElectionById(electionId, tx);
    if (!election) throw new NotFoundError("Election not found");
    assertOperationAllowed("reviewVoters", election);

    if (eligible) {
      await grantEligibility(electionId, voterId, tx);
    } else {
      const ring = await findRingForVoter(electionId, voterId, tx);
      if (ring) {
        throw new ConflictError(
          "This voter is already in an anonymity group for this election and cannot be removed from the roll.",
        );
      }
      await revokeEligibility(electionId, voterId, tx);
    }

    await recordAuditEntry(
      {
        adminId,
        action: eligible ? AuditAction.EligibilityGranted : AuditAction.EligibilityRevoked,
        entityType: "voter",
        entityId: voterId,
        electionId,
        before: { eligible: !eligible },
        after: { eligible },
      },
      tx,
    );
  });
}

export interface TransferOutcome {
  added: string[];
  alreadyOnRoll: string[];
  total: number;
}

/**
 * Moves already-vetted voters onto an election's roll in bulk.
 *
 * This is the enrolment half of a two-part decision the system deliberately keeps separate.
 * Registration is global and happens once: a person is vetted by a human, and a `voters` row is
 * minted. Being entitled to vote in a *particular* election is a second, per-election decision
 * recorded in `election_eligibility`. That split is what makes this operation possible at all —
 * a voter vetted for last year's election does not need re-vetting to take part in this one, only
 * enrolling.
 *
 * It is not a shortcut around review. Every voter in `voterIds` already passed the queue; nobody
 * reaches the `voters` table any other way. What is being skipped is the *identity check*, which
 * was already done, not the decision to enfranchise, which is exactly what this records.
 *
 * Runs as one transaction with the election locked, because enrolment is only legal while
 * registration is open and that state could be changing underneath us.
 */
export async function transferVotersOntoRoll(
  electionId: string,
  voterIds: readonly string[],
  adminId: string,
): Promise<TransferOutcome> {
  return db.transaction(async (tx) => {
    const election = await lockElectionById(electionId, tx);
    if (!election) throw new NotFoundError("Election not found");
    // Enrolling after registration closes would add a voter who belongs to no published group:
    // they would be told they can vote, and their ballot would never verify.
    assertOperationAllowed("reviewVoters", election);

    const unique = [...new Set(voterIds)];
    const added = await grantEligibilityMany(electionId, unique, tx);
    const addedSet = new Set(added);

    await recordAuditEntries(
      added.map((voterId) => ({
        adminId,
        action: AuditAction.EligibilityGranted,
        entityType: "voter",
        entityId: voterId,
        electionId,
        before: { eligible: false },
        after: { eligible: true, via: "bulk_transfer" },
      })),
      tx,
    );

    return {
      added,
      alreadyOnRoll: unique.filter((voterId) => !addedSet.has(voterId)),
      total: unique.length,
    };
  });
}

/**
 * Removes many voters from a roll.
 *
 * Anyone already placed in a ring is reported back rather than removed. The composite foreign key
 * from `ring_members` would refuse it at the database level anyway; refusing it here turns that
 * into an explanation. Removing somebody after their key is published in a ring does not
 * un-publish it — the ring still names them — so the only thing it would achieve is a roll that
 * disagrees with the ledger.
 */
export async function removeVotersFromRoll(
  electionId: string,
  voterIds: readonly string[],
  adminId: string,
): Promise<{ removed: string[]; lockedIntoRings: string[] }> {
  return db.transaction(async (tx) => {
    const election = await lockElectionById(electionId, tx);
    if (!election) throw new NotFoundError("Election not found");
    assertOperationAllowed("reviewVoters", election);

    const unique = [...new Set(voterIds)];
    const locked = await votersLockedIntoRings(electionId, unique, tx);
    const removable = unique.filter((voterId) => !locked.has(voterId));

    for (const voterId of removable) {
      await revokeEligibility(electionId, voterId, tx);
    }

    await recordAuditEntries(
      removable.map((voterId) => ({
        adminId,
        action: AuditAction.EligibilityRevoked,
        entityType: "voter",
        entityId: voterId,
        electionId,
        before: { eligible: true },
        after: { eligible: false, via: "bulk_transfer" },
      })),
      tx,
    );

    return { removed: removable, lockedIntoRings: [...locked] };
  });
}
