import { db } from "../db/drizzle";
import { findLatestEligibility } from "../db/repository/eligibility.repository";
import {
  createRegistration,
  findConflictingFields,
  findRegistrationById,
} from "../db/repository/registrations.repository";
import { findPendingRotationForVoter } from "../db/repository/keyRotations.repository";
import { findRingForVoter, listRingMembers } from "../db/repository/rings.repository";
import { assessRotationEligibility } from "./keyRotation.service";
import { findConflictingVoterFields } from "../db/repository/voters.repository";
import type { Registration } from "../db/schema";
import { asConflictError, conflictingFields } from "../lib/conflicts";
import { ConflictError, NotFoundError } from "../lib/errors";

export interface RegistrationSubmission {
  fullName: string;
  nationalId: string;
  email: string;
  publicKey: string;
}

const CONFLICT_MESSAGE = "This registration conflicts with an existing record";

function normalise(input: RegistrationSubmission): RegistrationSubmission {
  return {
    fullName: input.fullName.trim(),
    nationalId: input.nationalId.trim(),
    email: input.email.trim().toLowerCase(),
    publicKey: input.publicKey.trim(),
  };
}

/**
 * Handles `POST /register`. The caller is unauthenticated, so the response says only *which
 * field* collided and never echoes the existing record — otherwise this endpoint becomes a
 * lookup oracle for whether a given national id or email is registered. For the same reason
 * the collision is resolved to booleans inside Postgres rather than by fetching the
 * conflicting rows and comparing them here.
 */
export async function submitRegistration(
  input: RegistrationSubmission,
): Promise<Registration> {
  const claim = normalise(input);

  return db.transaction(async (tx) => {
    const [liveRegistrations, existingVoters] = await Promise.all([
      findConflictingFields(claim, tx),
      findConflictingVoterFields(claim, tx),
    ]);

    const fields = conflictingFields(liveRegistrations, existingVoters);
    if (fields.length > 0) {
      throw new ConflictError(CONFLICT_MESSAGE, { fields });
    }

    try {
      return await createRegistration(claim, tx);
    } catch (error) {
      // Another submission claiming the same identifier can commit between the check above
      // and this insert. The partial unique indexes catch it; this just reports it the same
      // way the check would have.
      const conflict = asConflictError(error, CONFLICT_MESSAGE);
      if (conflict) throw conflict;
      throw error;
    }
  });
}

export interface RegistrationStatusView {
  id: string;
  /** Short human reference, as printed in the confirmation email. */
  reference: string;
  status: Registration["status"];
  fullName: string;
  submittedAt: Date;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  registrationClosesAt: Date | null;
  votingOpensAt: Date | null;
  votingClosesAt: Date | null;
  electionTitle: string | null;
  /** Set once the voter has been placed in an anonymity group. */
  anonymityGroupSize: number | null;

  /**
   * Whether the voter can replace their voting key from here, and what it would affect.
   *
   * Served rather than inferred in the browser because the rule depends on the lifecycle state of
   * every election they belong to — and a page that offers a replacement the server would refuse is
   * worse than one that explains why it cannot.
   */
  keyReplacement: {
    available: boolean;
    /** Set when a replacement is already waiting for an officer to review it. */
    pendingRequest: boolean;
    /** True when a replacement takes effect immediately (registration not yet reviewed). */
    immediate: boolean;
    reason?: string;
    appliesTo: { id: string; title: string }[];
    alreadyFrozen: { id: string; title: string; status: string }[];
  };
}

/**
 * Backs the voter's own status page, reached from the link in their confirmation email.
 *
 * Authorisation here is the registration id itself: a v4 UUID that only reaches the person who
 * submitted the form. That is a deliberately modest control, and it is calibrated to what it
 * protects — the page reveals a name the caller already typed, a decision, and a rejection
 * reason. It does not reveal the national id, the email, or the public key, so a leaked link
 * exposes strictly less than the original submission did. Notably it also cannot reveal
 * anything about a ballot, because no such link exists to follow.
 *
 * The group *size* is shown because it is the voter's privacy guarantee and they are entitled
 * to know it. Group membership — who else is in it — is not returned: the voter has no need for
 * it here, and the ring is fetched at voting time through the ballot-access credential instead.
 */
export async function getRegistrationStatus(
  registrationId: string,
): Promise<RegistrationStatusView> {
  const registration = await findRegistrationById(registrationId);
  if (!registration) throw new NotFoundError("Registration not found");

  let electionTitle: string | null = null;
  let registrationClosesAt: Date | null = null;
  let votingOpensAt: Date | null = null;
  let votingClosesAt: Date | null = null;
  let anonymityGroupSize: number | null = null;

  // A registration nobody has reviewed yet can have its key corrected in place: there is no voter
  // record, no roll and no ring, so there is nothing for a replacement to be too late for.
  let keyReplacement: RegistrationStatusView["keyReplacement"] = {
    available: registration.status === "PENDING",
    pendingRequest: false,
    immediate: registration.status === "PENDING",
    appliesTo: [],
    alreadyFrozen: [],
    ...(registration.status === "REJECTED"
      ? {
          reason:
            "This registration was not approved, so there is no key to replace. Register again " +
            "with a new key instead.",
        }
      : {}),
  };

  if (registration.voterId) {
    const eligibility = await findLatestEligibility(registration.voterId);
    if (eligibility) {
      electionTitle = eligibility.election.title;
      registrationClosesAt = eligibility.election.registrationClosesAt;
      votingOpensAt = eligibility.election.votingOpensAt;
      votingClosesAt = eligibility.election.votingClosesAt;

      const ring = await findRingForVoter(
        eligibility.election.id,
        registration.voterId,
      );
      if (ring) {
        anonymityGroupSize = (await listRingMembers(ring.id)).length;
      }
    }

    const [eligibilityCheck, pending] = await Promise.all([
      assessRotationEligibility(registration.voterId),
      findPendingRotationForVoter(registration.voterId),
    ]);

    keyReplacement = {
      available: eligibilityCheck.allowed && !pending,
      pendingRequest: pending !== undefined,
      // An approved voter's replacement is reviewed by a person before it takes effect.
      immediate: false,
      appliesTo: eligibilityCheck.appliesTo,
      alreadyFrozen: eligibilityCheck.alreadyFrozen,
      ...(eligibilityCheck.reason ? { reason: eligibilityCheck.reason } : {}),
    };
  }

  return {
    id: registration.id,
    reference: buildReference(registration),
    status: registration.status,
    fullName: registration.fullName,
    submittedAt: registration.createdAt,
    reviewedAt: registration.reviewedAt,
    rejectionReason: registration.rejectionReason,
    registrationClosesAt,
    votingOpensAt,
    votingClosesAt,
    electionTitle,
    anonymityGroupSize,
    keyReplacement,
  };
}

/**
 * A short reference the voter can quote — the last eight characters of the id, uppercased.
 *
 * Display only. It is a prefix of a value the caller already holds, not a second credential,
 * and nothing accepts it as input.
 */
function buildReference(registration: Registration): string {
  return `SP-${registration.id.replace(/-/g, "").slice(-8).toUpperCase()}`;
}
