import { env } from "../config/env";
import { countCandidates } from "../db/repository/candidates.repository";
import {
  countUnassignedVoters,
  countUnpublishedRings,
  countsForElection,
} from "../db/repository/elections.repository";
import { countByStatus } from "../db/repository/registrations.repository";
import { listRingsWithSizes } from "../db/repository/rings.repository";
import type { Election, ElectionStatus } from "../db/schema";
import { ConflictError } from "../lib/errors";

/**
 * One pre-flight check, as the interface renders it: a pass/fail with a reason.
 *
 * The guards are returned as structured results rather than collapsed into a single boolean
 * or a prose error, because the screen fronting an irreversible action shows the admin
 * exactly which conditions hold and which do not. "Cannot open voting" tells them nothing;
 * "Cultural Secretary has 1 candidate" tells them what to go and fix.
 */
export interface GuardCheck {
  key: string;
  label: string;
  passed: boolean;
  /** Extra context shown beside the label, e.g. "3 candidates". */
  detail?: string;
}

export interface GuardReport {
  checks: GuardCheck[];
  passed: boolean;
}

function report(checks: GuardCheck[]): GuardReport {
  return { checks, passed: checks.every((check) => check.passed) };
}

function contestedCheck(candidates: number): GuardCheck {
  return {
    key: "candidatesContested",
    label: "At least 2 candidates",
    passed: candidates >= 2,
    detail:
      candidates === 0
        ? "no candidates recorded"
        : candidates === 1
          ? "only 1 candidate — an election needs a choice"
          : `${candidates} candidates`,
  };
}

/**
 * Checks that must hold before registration closes — that is, before the election leaves
 * REGISTRATION_OPEN for RINGS_FROZEN.
 *
 * The candidate check belongs *here*, not only on opening voting, and that placement is the
 * whole reason this function exists separately. Candidates are immutable from RINGS_FROZEN
 * onwards, because a ballot's signature commits to a candidate id. So an election that
 * entered RINGS_FROZEN with only one candidate would be stuck: it could not open voting
 * (the guard fails) and could not add the missing candidate (the operation is no longer
 * legal). Checking it on the way in is what keeps that state unreachable.
 */
export async function evaluateCloseRegistrationGuards(
  election: Election,
): Promise<GuardReport> {
  const [counts, registrationCounts, candidateCount] = await Promise.all([
    countsForElection(election.id),
    countByStatus(),
    countCandidates(election.id),
  ]);

  return report([
    {
      key: "reviewComplete",
      label: "No registrations still awaiting review",
      passed: registrationCounts.PENDING === 0,
      detail:
        registrationCounts.PENDING === 0
          ? "queue is clear"
          : `${registrationCounts.PENDING} pending`,
    },
    {
      key: "electorateExists",
      label: "The election has an approved electorate",
      passed: counts.eligibleVoters >= env.RING_MIN_SIZE,
      detail:
        counts.eligibleVoters === 0
          ? "no approved voters"
          : counts.eligibleVoters < env.RING_MIN_SIZE
            ? `${counts.eligibleVoters} approved — at least ${env.RING_MIN_SIZE} needed to form one group`
            : `${counts.eligibleVoters} approved`,
    },
    contestedCheck(candidateCount),
  ]);
}

/**
 * Checks that must hold before ring membership is frozen and published to the ledger.
 *
 * Everything here is about not stranding a voter. After publication membership cannot change,
 * so a voter who is unassigned, or sitting in an undersized group at this moment, is a voter
 * whose ballot will either fail to verify or fail to be anonymous — and there will be no way
 * to repair it, because the ledger already holds the consequence.
 */
export async function evaluatePublishGuards(election: Election): Promise<GuardReport> {
  // No ledger-reachability check: publication is now the act of exporting a manifest that
  // nodes import from disk, so no node needs to be up for it to succeed.
  const [counts, unassigned, ringSizes, registrationCounts, candidateCount] = await Promise.all([
    countsForElection(election.id),
    countUnassignedVoters(election.id),
    listRingsWithSizes(election.id),
    countByStatus(),
    countCandidates(election.id),
  ]);

  const smallest = ringSizes.length
    ? Math.min(...ringSizes.map((entry) => entry.size))
    : 0;

  return report([
    {
      key: "ringsFormed",
      label: "Anonymity groups have been formed",
      passed: ringSizes.length > 0,
      detail: ringSizes.length ? `${ringSizes.length} groups` : "no groups formed yet",
    },
    {
      key: "everyVoterAssigned",
      label: "Every approved voter is in exactly one group",
      passed: counts.eligibleVoters > 0 && unassigned === 0,
      detail:
        counts.eligibleVoters === 0
          ? "no approved voters in this election"
          : unassigned === 0
            ? `${counts.eligibleVoters} voters assigned`
            : `${unassigned} unassigned`,
    },
    {
      key: "minimumGroupSize",
      label: `No group smaller than ${env.RING_MIN_SIZE}`,
      passed: ringSizes.length > 0 && smallest >= env.RING_MIN_SIZE,
      detail: ringSizes.length ? `smallest group has ${smallest}` : undefined,
    },
    {
      key: "reviewComplete",
      label: "No registrations still awaiting review",
      passed: registrationCounts.PENDING === 0,
      detail:
        registrationCounts.PENDING === 0
          ? "queue is clear"
          : `${registrationCounts.PENDING} pending`,
    },
    contestedCheck(candidateCount),
  ]);
}

/**
 * Checks that must hold before voting opens. From the project context, §6.1: at least two
 * candidates, every ring published, and every approved voter in exactly one ring.
 */
export async function evaluateVotingOpenGuards(election: Election): Promise<GuardReport> {
  const [counts, unassigned, unpublished, candidateCount, ringSizes] = await Promise.all([
    countsForElection(election.id),
    countUnassignedVoters(election.id),
    countUnpublishedRings(election.id),
    countCandidates(election.id),
    listRingsWithSizes(election.id),
  ]);

  const smallest = ringSizes.length
    ? Math.min(...ringSizes.map((entry) => entry.size))
    : 0;

  return report([
    contestedCheck(candidateCount),
    {
      key: "ringsFormed",
      label: "Anonymity groups formed",
      passed: ringSizes.length > 0,
      detail: ringSizes.length ? `${ringSizes.length} groups` : "none formed",
    },
    {
      key: "ringsPublished",
      label: "Every group published to the ledger",
      passed: ringSizes.length > 0 && unpublished === 0,
      detail:
        ringSizes.length === 0
          ? "nothing to publish yet"
          : unpublished === 0
            ? `${counts.ringsPublished} published`
            : `${unpublished} not yet published`,
    },
    {
      key: "everyVoterAssigned",
      label: "Every approved voter in exactly one group",
      passed: counts.eligibleVoters > 0 && unassigned === 0,
      detail: unassigned === 0 ? undefined : `${unassigned} unassigned`,
    },
    {
      key: "minimumGroupSize",
      label: `No group smaller than ${env.RING_MIN_SIZE}`,
      passed: ringSizes.length > 0 && smallest >= env.RING_MIN_SIZE,
      detail: ringSizes.length ? `smallest group has ${smallest}` : undefined,
    },
  ]);
}

/**
 * The pre-flight for a given transition. Transitions with no preconditions — cancelling,
 * closing voting, publishing a tally the ledger already holds — return an empty all-clear.
 */
export async function evaluateTransitionGuards(
  election: Election,
  to: ElectionStatus,
): Promise<GuardReport> {
  if (to === "RINGS_FROZEN") return evaluateCloseRegistrationGuards(election);
  if (to === "VOTING_OPEN") return evaluateVotingOpenGuards(election);
  return report([]);
}

export async function assertTransitionGuardsPass(
  election: Election,
  to: ElectionStatus,
): Promise<void> {
  const guards = await evaluateTransitionGuards(election, to);
  if (!guards.passed) {
    const failed = guards.checks.filter((check) => !check.passed);
    throw new ConflictError(
      `This election is not ready: ${failed.map((check) => check.label).join("; ")}`,
      { checks: guards.checks },
    );
  }
}
