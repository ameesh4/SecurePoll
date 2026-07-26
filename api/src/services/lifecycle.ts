import type { Election, ElectionStatus } from "../db/schema";
import { ConflictError, ForbiddenError } from "../lib/errors";

/**
 * The election lifecycle, as a state machine the server enforces.
 *
 * This is deliberately not "the UI hides the buttons". A hidden button is a suggestion; the
 * table below is the rule. Every mutating service calls `assertOperationAllowed` before it
 * touches anything, so an admin replaying a request from an earlier state — or a script
 * calling the API directly — is refused rather than obeyed.
 *
 *   DRAFT ──▶ REGISTRATION_OPEN ──▶ RINGS_FROZEN ──▶ VOTING_OPEN ──▶ VOTING_CLOSED ──▶ TALLIED
 *      │              │
 *      └──▶ CANCELLED ◀┘
 */

export const ELECTION_STATUSES = [
  "DRAFT",
  "REGISTRATION_OPEN",
  "RINGS_FROZEN",
  "VOTING_OPEN",
  "VOTING_CLOSED",
  "TALLIED",
  "CANCELLED",
] as const satisfies readonly ElectionStatus[];

/**
 * Human labels, matching the vocabulary the interface uses.
 *
 * Rings are called "anonymity groups" and the key image a "duplicate-ballot check" in every
 * voter- and admin-facing string. Not decoration: an admin who is asked to confirm something
 * irreversible has to understand what they are confirming, and "freeze the LSAG rings" does
 * not communicate "3,204 people are now locked into their groups".
 */
export const STATUS_LABELS: Record<ElectionStatus, string> = {
  DRAFT: "Draft",
  REGISTRATION_OPEN: "Registration open",
  RINGS_FROZEN: "Groups frozen",
  VOTING_OPEN: "Voting open",
  VOTING_CLOSED: "Voting closed",
  TALLIED: "Tallied",
  CANCELLED: "Cancelled",
};

/** The ordered spine shown as the lifecycle rail. CANCELLED is off to one side. */
export const LIFECYCLE_STAGES = [
  "DRAFT",
  "REGISTRATION_OPEN",
  "RINGS_FROZEN",
  "VOTING_OPEN",
  "VOTING_CLOSED",
  "TALLIED",
] as const satisfies readonly ElectionStatus[];

const TRANSITIONS: Record<ElectionStatus, readonly ElectionStatus[]> = {
  DRAFT: ["REGISTRATION_OPEN", "CANCELLED"],
  REGISTRATION_OPEN: ["RINGS_FROZEN", "CANCELLED"],
  // No path back to REGISTRATION_OPEN. Reopening registration after groups were formed
  // would admit voters who belong to no published ring, and their ballots could never
  // verify — they would be told they had registered and then silently not count.
  RINGS_FROZEN: ["VOTING_OPEN"],
  VOTING_OPEN: ["VOTING_CLOSED"],
  VOTING_CLOSED: ["TALLIED"],
  TALLIED: [],
  CANCELLED: [],
};

export function allowedTransitions(from: ElectionStatus): readonly ElectionStatus[] {
  return TRANSITIONS[from];
}

export function assertTransitionAllowed(from: ElectionStatus, to: ElectionStatus): void {
  if (from === to) {
    throw new ConflictError(`This election is already ${STATUS_LABELS[to].toLowerCase()}`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new ConflictError(
      `An election cannot move from ${STATUS_LABELS[from].toLowerCase()} to ${STATUS_LABELS[
        to
      ].toLowerCase()}`,
      { from, to, allowed: TRANSITIONS[from] },
    );
  }
}

/**
 * Operations gated on lifecycle state. The names match the rows of the operations table in
 * the project context, §6.1.
 */
export type ElectionOperation =
  | "editMetadata"
  | "manageCandidates"
  | "reviewVoters"
  | "formRings"
  | "publishRings"
  | "issueTokens"
  | "viewTally";

const OPERATION_STATES: Record<ElectionOperation, readonly ElectionStatus[]> = {
  editMetadata: ["DRAFT", "REGISTRATION_OPEN"],
  // Candidate ids are what a ballot's signature commits to, so the set is fixed before any
  // ring exists to sign against it.
  manageCandidates: ["DRAFT", "REGISTRATION_OPEN"],
  reviewVoters: ["REGISTRATION_OPEN"],
  // Formation and publication both live in RINGS_FROZEN: entering the state forms the
  // groups, and publishing them is the step that makes membership permanent. Re-forming is
  // legal until the first ring is published, which the ring service checks separately.
  formRings: ["RINGS_FROZEN"],
  publishRings: ["RINGS_FROZEN"],
  issueTokens: ["RINGS_FROZEN", "VOTING_OPEN"],
  viewTally: ["VOTING_CLOSED", "TALLIED"],
};

const OPERATION_LABELS: Record<ElectionOperation, string> = {
  editMetadata: "Editing election details",
  manageCandidates: "Changing candidates",
  reviewVoters: "Reviewing voters",
  formRings: "Forming anonymity groups",
  publishRings: "Publishing anonymity groups",
  issueTokens: "Issuing ballot access",
  viewTally: "Viewing the result",
};

export function isOperationAllowed(
  operation: ElectionOperation,
  status: ElectionStatus,
): boolean {
  return OPERATION_STATES[operation].includes(status);
}

export function assertOperationAllowed(
  operation: ElectionOperation,
  election: Pick<Election, "status">,
): void {
  if (!isOperationAllowed(operation, election.status)) {
    throw new ConflictError(
      `${OPERATION_LABELS[operation]} is not allowed while the election is ${STATUS_LABELS[
        election.status
      ].toLowerCase()}`,
      { operation, status: election.status },
    );
  }
}

/**
 * Which operations are legal right now, for the "actions available" panel.
 *
 * Returned by the API rather than derived in the browser so the screen and the server can
 * never disagree about what is permitted.
 */
export function availableOperations(
  status: ElectionStatus,
): Record<ElectionOperation, boolean> {
  return {
    editMetadata: isOperationAllowed("editMetadata", status),
    manageCandidates: isOperationAllowed("manageCandidates", status),
    reviewVoters: isOperationAllowed("reviewVoters", status),
    formRings: isOperationAllowed("formRings", status),
    publishRings: isOperationAllowed("publishRings", status),
    issueTokens: isOperationAllowed("issueTokens", status),
    viewTally: isOperationAllowed("viewTally", status),
  };
}

/**
 * Transitions that cannot be undone by anyone, and are therefore restricted to a super-admin
 * and fronted by a typed confirmation in the interface.
 *
 * Freezing writes ring membership into the ledger; opening voting starts accepting ballots
 * against those rings; closing voting expires every unused ballot-access credential. None of
 * the three has a reverse operation, and none can be repaired by a database edit, because
 * the ledger already holds the consequence.
 */
const IRREVERSIBLE: readonly ElectionStatus[] = [
  "RINGS_FROZEN",
  "VOTING_OPEN",
  "VOTING_CLOSED",
];

export function isIrreversibleTransition(to: ElectionStatus): boolean {
  return IRREVERSIBLE.includes(to);
}

export function assertSuperAdmin(role: string, action: string): void {
  if (role !== "SUPER_ADMIN") {
    throw new ForbiddenError(`${action} requires a super-admin`);
  }
}
