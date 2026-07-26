import { db } from "../db/drizzle";
import { recordAuditEntry } from "../db/repository/auditLog.repository";
import { listEligibilityWithElections } from "../db/repository/eligibility.repository";
import {
  createRotationRequest,
  findPendingRotationForVoter,
  listPendingRotations,
  lockRotationRequestById,
  markRotationReviewed,
  type RotationRequestRow,
} from "../db/repository/keyRotations.repository";
import {
  findRegistrationById,
  lockRegistrationById,
  updateRegistrationPublicKey,
} from "../db/repository/registrations.repository";
import {
  findVoterById,
  findVoterConflicts,
  updateVoterPublicKey,
} from "../db/repository/voters.repository";
import type { ElectionStatus, KeyRotationRequest } from "../db/schema";
import { AuditAction } from "../db/schema";
import { asConflictError } from "../lib/conflicts";
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors";
import { mailer } from "../lib/mailer";
import {
  keyReplacementApprovedEmail,
  keyReplacementRejectedEmail,
  keyReplacementRequestedEmail,
} from "../lib/mailer/templates";
import { describeVoterPublicKey } from "../lib/publicKey";
import { STATUS_LABELS } from "./lifecycle";

/**
 * Replacing the voting key on a voter's record, after they lose the private half.
 *
 * The private key is generated on the voter's device and never reaches this server, so nobody here
 * can reissue it — a lost key can only be *replaced*, and only the voter can produce the
 * replacement. That is why this flow has to start with them.
 *
 * It is deliberately not fully self-service. The only thing authenticating a voter is possession of
 * their registration link, which arrived by email; the ballot-access link arrives by the same
 * email. Today somebody holding that inbox can collect a ballot link but cannot sign with it, so
 * the worst they can do is deny the real voter their vote. If they could also install a public key
 * they hold, they could cast that person's ballot instead. So:
 *
 *  - A registration still awaiting review is corrected in place. There is no voter record yet, no
 *    ring contains the key, and an admin is about to examine the record anyway.
 *  - An approved voter files a request that an admin approves. The identity check has already been
 *    done; what a person is confirming here is that the *request* is genuine.
 */

/** Stages in which an election's group membership is not yet fixed. */
const ROTATION_SAFE_STATES: readonly ElectionStatus[] = ["DRAFT", "REGISTRATION_OPEN"];

export interface RotationEligibility {
  allowed: boolean;
  /** Elections the new key will apply to. */
  appliesTo: { id: string; title: string }[];
  /**
   * Elections it will not help with, because their groups are already frozen against the old key.
   * Not a failure — those rings keep the key they were published with, by design.
   */
  alreadyFrozen: { id: string; title: string; status: string }[];
  reason?: string;
}

/**
 * Whether a voter may replace their key right now, and what it will affect.
 *
 * The rule follows from where the key actually lives once groups are formed. `ring_members`
 * snapshots each public key at formation time, so rotating `voters.publicKey` cannot disturb a
 * ring that has already been published — every signature made against it still verifies. What
 * rotation cannot do is get a voter into a ring they are already in under a different key. So a
 * replacement is useful exactly while some election they belong to still has its roll open, and
 * pointless (though harmless) for the ones that have moved on.
 */
export async function assessRotationEligibility(
  voterId: string,
): Promise<RotationEligibility> {
  const enrolments = await listEligibilityWithElections(voterId);

  const appliesTo = enrolments
    .filter((entry) => ROTATION_SAFE_STATES.includes(entry.election.status))
    .map((entry) => ({ id: entry.election.id, title: entry.election.title }));

  const alreadyFrozen = enrolments
    .filter((entry) => !ROTATION_SAFE_STATES.includes(entry.election.status))
    .map((entry) => ({
      id: entry.election.id,
      title: entry.election.title,
      status: STATUS_LABELS[entry.election.status],
    }));

  // A voter on no roll at all can still replace their key: there is nothing to conflict with, and
  // they will be enrolled with whatever key their record holds at that time.
  if (enrolments.length === 0) {
    return { allowed: true, appliesTo, alreadyFrozen };
  }

  if (appliesTo.length === 0) {
    return {
      allowed: false,
      appliesTo,
      alreadyFrozen,
      reason:
        "Every election you are on has already closed its registration and frozen its anonymity " +
        "groups. Those groups contain your old key and cannot be changed, so a new key would not " +
        "let you vote in them. Speak to an election officer.",
    };
  }

  return { allowed: true, appliesTo, alreadyFrozen };
}

function assertUsableKey(publicKey: string): void {
  const problem = describeVoterPublicKey(publicKey);
  if (problem) {
    throw new BadRequestError(problem, { fieldErrors: { publicKey: [problem] } });
  }
}

const KEY_TAKEN =
  "That voting key is already registered to somebody else. Generate a new one and try again.";

export interface RotationOutcome {
  /** True when the new key is already in effect; false when it is awaiting an admin's decision. */
  applied: boolean;
  requestId?: string;
  eligibility: RotationEligibility;
}

/**
 * Handles a voter's request to replace their key.
 *
 * Accepts the public half only. There is no parameter here for a private key, seed or mnemonic and
 * there must never be one — the moment this server can hold a voter's private key it can forge
 * their ballot, and the anonymity argument collapses.
 */
export async function requestKeyReplacement(input: {
  registrationId: string;
  newPublicKey: string;
  reason?: string;
}): Promise<RotationOutcome> {
  const newPublicKey = input.newPublicKey.trim();
  assertUsableKey(newPublicKey);

  const registration = await findRegistrationById(input.registrationId);
  if (!registration) throw new NotFoundError("Registration not found");

  if (registration.status === "REJECTED") {
    throw new ConflictError(
      "This registration was not approved, so there is no key to replace. Register again with a " +
        "new key instead.",
    );
  }

  // ── Still awaiting review: correct the submission in place. ────────────────────────────────
  if (registration.status === "PENDING") {
    if (registration.publicKey === newPublicKey) {
      throw new ConflictError("That is already the key on your registration");
    }

    await db.transaction(async (tx) => {
      const locked = await lockRegistrationById(input.registrationId, tx);
      if (!locked) throw new NotFoundError("Registration not found");
      if (locked.status !== "PENDING") {
        throw new ConflictError(
          "Your registration has just been reviewed, so its key can no longer be edited " +
            "directly. Reload the page to see the outcome.",
        );
      }

      /**
       * Checked against `voters` as well as against other registrations.
       *
       * The partial unique index on `registrations` is not sufficient on its own, and rotation is
       * precisely why: approving a rotation moves `voters.publicKey` on while leaving the
       * registration holding the key originally claimed. So a key can be live on a voter that no
       * registration holds — and without this check a pending registration could quietly adopt it,
       * passing the index here and then failing at approval time with a conflict nobody can act on.
       */
      const heldByVoter = await findVoterConflicts(
        { nationalId: locked.nationalId, email: locked.email, publicKey: newPublicKey },
        tx,
      );
      if (heldByVoter.some((row) => row.publicKey === newPublicKey)) {
        throw new ConflictError(KEY_TAKEN);
      }

      let updated;
      try {
        updated = await updateRegistrationPublicKey(locked.id, newPublicKey, tx);
      } catch (error) {
        const conflict = asConflictError(error, KEY_TAKEN);
        if (conflict) throw conflict;
        throw error;
      }

      await recordAuditEntry(
        {
          adminId: null,
          action: AuditAction.KeyRotatedOnRegistration,
          entityType: "registration",
          entityId: locked.id,
          before: { publicKey: locked.publicKey },
          after: { publicKey: updated.publicKey, reason: input.reason ?? null },
        },
        tx,
      );

    });

    // A pending registration is on no roll yet, so there is nothing for the new key to apply to
    // or to be too late for — it simply becomes the key the reviewing admin sees.
    return {
      applied: true,
      eligibility: { allowed: true, appliesTo: [], alreadyFrozen: [] },
    };
  }

  // ── Approved: file a request for a person to approve. ──────────────────────────────────────
  const voterId = registration.voterId;
  if (!voterId) {
    throw new ConflictError("This registration has no voter record to update");
  }

  const voter = await findVoterById(voterId);
  if (!voter) throw new NotFoundError("Voter not found");

  if (voter.publicKey === newPublicKey) {
    throw new ConflictError("That is already the key on your record");
  }

  const eligibility = await assessRotationEligibility(voterId);
  if (!eligibility.allowed) {
    throw new ConflictError(eligibility.reason ?? "Your key cannot be replaced right now", {
      eligibility,
    });
  }

  const existing = await findPendingRotationForVoter(voterId);
  if (existing) {
    throw new ConflictError(
      "You already have a key replacement waiting for an election officer to review. They will " +
        "email you when it has been looked at.",
      { requestId: existing.id },
    );
  }

  // Checked before writing so the voter gets a clear message rather than a constraint violation.
  // The unique index on voters.public_key remains the actual enforcement at approval time.
  const collisions = (await findVoterConflicts({
    nationalId: voter.nationalId,
    email: voter.email,
    publicKey: newPublicKey,
  })).filter((row) => row.id !== voterId && row.publicKey === newPublicKey);
  if (collisions.length > 0) throw new ConflictError(KEY_TAKEN);

  const request = await db.transaction(async (tx) => {
    let created: KeyRotationRequest;
    try {
      created = await createRotationRequest(
        {
          registrationId: registration.id,
          voterId,
          newPublicKey,
          previousPublicKey: voter.publicKey,
          reason: input.reason?.trim() || null,
        },
        tx,
      );
    } catch (error) {
      // The partial unique index catches a second request racing the check above.
      const conflict = asConflictError(error, "You already have a request awaiting review");
      if (conflict) throw conflict;
      throw error;
    }

    await recordAuditEntry(
      {
        adminId: null,
        action: AuditAction.KeyRotationRequested,
        entityType: "voter",
        entityId: voterId,
        before: { publicKey: voter.publicKey },
        after: { requestedPublicKey: newPublicKey, requestId: created.id },
      },
      tx,
    );

    return created;
  });

  deliver(
    keyReplacementRequestedEmail({
      to: voter.email,
      fullName: voter.fullName,
      statusUrl: null,
    }),
  );

  return { applied: false, requestId: request.id, eligibility };
}

/**
 * Delivery must never undo a committed decision, so failures are logged rather than thrown. The
 * request already exists and the audit log already records it.
 */
function deliver(message: Parameters<typeof mailer.send>[0]): void {
  void mailer.send(message).catch((error: unknown) => {
    console.error(
      "[mailer] failed to deliver:",
      error instanceof Error ? error.message : error,
    );
  });
}

export interface RotationReview {
  approve: boolean;
  rejectionReason?: string;
}

/**
 * An admin's decision on a key replacement.
 *
 * Approving swaps the key on the voter's record inside the same transaction that records the
 * decision, so the two can never disagree. Rings already published keep the key they were
 * published with — that is what makes this operation safe rather than destructive.
 */
export async function reviewKeyReplacement(
  requestId: string,
  review: RotationReview,
  adminId: string,
): Promise<KeyRotationRequest> {
  const { request, voterEmail, voterName } = await db.transaction(async (tx) => {
    const pending = await lockRotationRequestById(requestId, tx);
    if (!pending) throw new NotFoundError("Key replacement request not found");
    if (pending.status !== "PENDING") {
      throw new ConflictError(
        `This request has already been ${pending.status.toLowerCase()}`,
      );
    }

    const voter = await findVoterById(pending.voterId, tx);
    if (!voter) throw new NotFoundError("Voter not found");

    if (!review.approve) {
      const reason = review.rejectionReason?.trim();
      if (!reason || reason.length < 3) {
        throw new BadRequestError("Give the voter a usable reason", {
          fieldErrors: { rejectionReason: ["Give the voter a usable reason"] },
        });
      }

      const rejected = await markRotationReviewed(
        requestId,
        { status: "REJECTED", adminId, rejectionReason: reason },
        tx,
      );

      await recordAuditEntry(
        {
          adminId,
          action: AuditAction.KeyRotationRejected,
          entityType: "voter",
          entityId: pending.voterId,
          before: { requestedPublicKey: pending.newPublicKey },
          after: { status: "REJECTED", rejectionReason: reason },
        },
        tx,
      );

      return { request: rejected, voterEmail: voter.email, voterName: voter.fullName };
    }

    // Re-checked under the lock rather than trusting what the admin saw. A request can sit in the
    // queue for days, and an election that was open when it was filed may since have frozen its
    // groups — approving then would install a key that no published ring contains, quietly
    // disenfranchising the voter it was meant to help.
    const enrolments = await listEligibilityWithElections(pending.voterId, tx);
    const stillOpen = enrolments.filter((entry) =>
      ROTATION_SAFE_STATES.includes(entry.election.status),
    );
    if (enrolments.length > 0 && stillOpen.length === 0) {
      throw new ConflictError(
        "Every election this voter is on has frozen its anonymity groups since this request was " +
          "filed. Replacing the key now would leave them with a key no published group contains.",
        {
          frozen: enrolments.map((entry) => ({
            title: entry.election.title,
            status: STATUS_LABELS[entry.election.status],
          })),
        },
      );
    }

    let updatedVoter;
    try {
      updatedVoter = await updateVoterPublicKey(pending.voterId, pending.newPublicKey, tx);
    } catch (error) {
      const conflict = asConflictError(error, KEY_TAKEN);
      if (conflict) throw conflict;
      throw error;
    }

    const approved = await markRotationReviewed(
      requestId,
      { status: "APPROVED", adminId },
      tx,
    );

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.KeyRotationApproved,
        entityType: "voter",
        entityId: pending.voterId,
        before: { publicKey: pending.previousPublicKey },
        after: { publicKey: updatedVoter.publicKey },
      },
      tx,
    );

    return { request: approved, voterEmail: voter.email, voterName: voter.fullName };
  });

  deliver(
    request.status === "APPROVED"
      ? keyReplacementApprovedEmail({ to: voterEmail, fullName: voterName })
      : keyReplacementRejectedEmail({
          to: voterEmail,
          fullName: voterName,
          reason: request.rejectionReason ?? "",
        }),
  );

  return request;
}

export async function getPendingRotations(params: {
  page: number;
  pageSize: number;
}): Promise<{ rows: RotationRequestRow[]; total: number }> {
  return listPendingRotations(params);
}
