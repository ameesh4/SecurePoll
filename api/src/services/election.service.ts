import { db } from "../db/drizzle";
import { recordAuditEntry } from "../db/repository/auditLog.repository";
import { listCandidates } from "../db/repository/candidates.repository";
import {
  countUnassignedVoters,
  countsForElection,
  countsForElections,
  createElection,
  findElectionById,
  listElections,
  lockElectionById,
  setElectionStatus,
  updateElection,
  type ElectionCounts,
} from "../db/repository/elections.repository";
import { listRingsWithSizes } from "../db/repository/rings.repository";
import { AuditAction, type Election, type ElectionStatus } from "../db/schema";
import { chainFor } from "../lib/chain";
import { BadRequestError, NotFoundError } from "../lib/errors";
import {
  assertTransitionGuardsPass,
  evaluateTransitionGuards,
  type GuardReport,
} from "./guards.service";
import {
  assertOperationAllowed,
  assertSuperAdmin,
  assertTransitionAllowed,
  allowedTransitions,
  availableOperations,
  isIrreversibleTransition,
  STATUS_LABELS,
  type ElectionOperation,
} from "./lifecycle";

export interface ElectionInput {
  title: string;
  description?: string | null;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
  votingOpensAt?: Date | null;
  votingClosesAt?: Date | null;
  ringSize?: number;
  chainRootIp?: string | null;
  chainRootPort?: number | null;
}

export interface ElectionSummary {
  election: Election;
  counts: ElectionCounts;
}

export interface ElectionDetail extends ElectionSummary {
  operations: Record<ElectionOperation, boolean>;
  transitions: readonly ElectionStatus[];
  /** Pre-flight for the next meaningful step, so the detail screen can render it inline. */
  guards: GuardReport;
  unassignedVoters: number;
  /** How many names are on the ballot — the "at least 2 candidates" guard is decided on this. */
  candidateCount: number;
}

export async function getElection(id: string): Promise<Election> {
  const election = await findElectionById(id);
  if (!election) throw new NotFoundError("Election not found");
  return election;
}

export async function listElectionSummaries(): Promise<ElectionSummary[]> {
  const rows = await listElections();
  const counts = await countsForElections(rows.map((row) => row.id));
  return rows.map((election) => ({
    election,
    counts:
      counts.get(election.id) ??
      {
        electionId: election.id,
        eligibleVoters: 0,
        candidates: 0,
        rings: 0,
        ringsPublished: 0,
        ringMembers: 0,
        tokensIssued: 0,
        tokensRedeemed: 0,
      },
  }));
}

/**
 * The transition an admin is most likely to be reaching for from the current state, which is
 * the one the detail screen shows a pre-flight for.
 */
function nextStage(status: ElectionStatus): ElectionStatus | null {
  const forward = allowedTransitions(status).filter((next) => next !== "CANCELLED");
  return forward[0] ?? null;
}

export async function getElectionDetail(id: string): Promise<ElectionDetail> {
  const election = await getElection(id);
  const next = nextStage(election.status);

  const [counts, unassigned, candidateRows, guards] = await Promise.all([
    countsForElection(election.id),
    countUnassignedVoters(election.id),
    listCandidates(election.id),
    next ? evaluateTransitionGuards(election, next) : Promise.resolve({ checks: [], passed: true }),
  ]);

  return {
    election,
    counts,
    operations: availableOperations(election.status),
    transitions: allowedTransitions(election.status),
    guards,
    unassignedVoters: unassigned,
    candidateCount: candidateRows.length,
  };
}

function assertVotingWindow(input: {
  votingOpensAt?: Date | null;
  votingClosesAt?: Date | null;
}): void {
  const { votingOpensAt, votingClosesAt } = input;
  if (votingOpensAt && votingClosesAt && votingClosesAt <= votingOpensAt) {
    throw new BadRequestError("Voting must close after it opens", {
      fieldErrors: { votingClosesAt: ["Must be after voting opens"] },
    });
  }
}

export async function createNewElection(
  input: ElectionInput,
  adminId: string,
): Promise<Election> {
  assertVotingWindow(input);

  return db.transaction(async (tx) => {
    const election = await createElection(
      {
        title: input.title.trim(),
        description: input.description?.trim() || null,
        registrationOpensAt: input.registrationOpensAt ?? null,
        registrationClosesAt: input.registrationClosesAt ?? null,
        votingOpensAt: input.votingOpensAt ?? null,
        votingClosesAt: input.votingClosesAt ?? null,
        ...(input.ringSize === undefined ? {} : { ringSize: input.ringSize }),
        chainRootIp: input.chainRootIp?.trim() || null,
        chainRootPort: input.chainRootPort ?? null,
      },
      tx,
    );

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.ElectionCreated,
        entityType: "election",
        entityId: election.id,
        electionId: election.id,
        before: null,
        after: { title: election.title, status: election.status },
      },
      tx,
    );

    return election;
  });
}

function metadataSnapshot(election: Election) {
  return {
    title: election.title,
    description: election.description,
    registrationOpensAt: election.registrationOpensAt,
    registrationClosesAt: election.registrationClosesAt,
    votingOpensAt: election.votingOpensAt,
    votingClosesAt: election.votingClosesAt,
    ringSize: election.ringSize,
  };
}

export async function updateElectionMetadata(
  id: string,
  input: Partial<ElectionInput>,
  adminId: string,
): Promise<Election> {
  assertVotingWindow(input);

  return db.transaction(async (tx) => {
    const election = await lockElectionById(id, tx);
    if (!election) throw new NotFoundError("Election not found");
    // Metadata is frozen from RINGS_FROZEN onward. Group size in particular: changing it
    // after groups exist would describe an electorate that is no longer how it was divided.
    assertOperationAllowed("editMetadata", election);

    const updated = await updateElection(
      id,
      {
        ...(input.title === undefined ? {} : { title: input.title.trim() }),
        ...(input.description === undefined
          ? {}
          : { description: input.description?.trim() || null }),
        ...(input.registrationOpensAt === undefined
          ? {}
          : { registrationOpensAt: input.registrationOpensAt }),
        ...(input.registrationClosesAt === undefined
          ? {}
          : { registrationClosesAt: input.registrationClosesAt }),
        ...(input.votingOpensAt === undefined
          ? {}
          : { votingOpensAt: input.votingOpensAt }),
        ...(input.votingClosesAt === undefined
          ? {}
          : { votingClosesAt: input.votingClosesAt }),
        ...(input.ringSize === undefined ? {} : { ringSize: input.ringSize }),
        ...(input.chainRootIp === undefined
          ? {}
          : { chainRootIp: input.chainRootIp?.trim() || null }),
        ...(input.chainRootPort === undefined
          ? {}
          : { chainRootPort: input.chainRootPort ?? null }),
      },
      tx,
    );

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.ElectionUpdated,
        entityType: "election",
        entityId: id,
        electionId: id,
        before: metadataSnapshot(election),
        after: metadataSnapshot(updated),
      },
      tx,
    );

    return updated;
  });
}

/** Pre-flight for a transition, read-only, so the confirmation dialog can show it. */
export async function previewTransition(
  id: string,
  to: ElectionStatus,
): Promise<GuardReport & { irreversible: boolean }> {
  const election = await getElection(id);
  assertTransitionAllowed(election.status, to);
  const guards = await evaluateTransitionGuards(election, to);
  return { ...guards, irreversible: isIrreversibleTransition(to) };
}

/**
 * Moves an election to a new lifecycle state.
 *
 * The order here matters and is not incidental:
 *
 *  1. Lock the row, so two admins cannot both pass the guards and both transition.
 *  2. Check the transition is legal from the current state.
 *  3. Check the role — the irreversible steps need a super-admin.
 *  4. Re-evaluate the guards *inside* the transaction. The admin saw a pre-flight on their
 *     screen some seconds or minutes ago; a registration approved since then could have
 *     added an unassigned voter. The screen's pre-flight is a courtesy, this one is the rule.
 *  5. Write the state, then the audit entry, in the same transaction as the check.
 */
export async function transitionElection(
  id: string,
  to: ElectionStatus,
  admin: { id: string; role: string },
): Promise<Election> {
  const updated = await db.transaction(async (tx) => {
    const election = await lockElectionById(id, tx);
    if (!election) throw new NotFoundError("Election not found");

    assertTransitionAllowed(election.status, to);

    /**
     * Every transition needs a super-admin, not just the irreversible ones.
     *
     * The role split is meant to read as one sentence: a reviewer works *within* a stage, a
     * super-admin moves the election *between* stages. Gating only the irreversible three left a
     * reviewer able to open registration — which starts accepting real submissions under this
     * election's name — and to close it, which fixes the candidate list permanently. Neither is a
     * reviewing task, and neither is obvious from a per-transition list of exceptions.
     */
    assertSuperAdmin(
      admin.role,
      `${isIrreversibleTransition(to) ? "Irreversibly moving" : "Moving"} an election to ${STATUS_LABELS[
        to
      ].toLowerCase()}`,
    );

    await assertTransitionGuardsPass(election, to);

    const next = await setElectionStatus(id, to, tx);

    await recordAuditEntry(
      {
        adminId: admin.id,
        action: AuditAction.ElectionTransitioned,
        entityType: "election",
        entityId: id,
        electionId: id,
        before: { status: election.status },
        after: { status: next.status },
      },
      tx,
    );

    return next;
  });

  // Publishing the configuration is what lets a node recognise ballots for this election at
  // all, so it happens as voting opens. Deliberately after the transaction commits: a
  // ledger write cannot be rolled back, so it must not sit inside one that might.
  if (updated.status === "VOTING_OPEN") {
    await publishConfiguration(updated);
  }

  return updated;
}

async function publishConfiguration(election: Election): Promise<void> {
  if (!election.votingOpensAt || !election.votingClosesAt) return;

  const candidates = await listCandidates(election.id);
  try {
    await chainFor(election).publishElectionConfig({
      electionId: election.id,
      title: election.title,
      candidateIds: candidates.map((candidate) => candidate.id),
      votingOpensAt: election.votingOpensAt,
      votingClosesAt: election.votingClosesAt,
    });
  } catch (error) {
    // Logged rather than thrown: voting is already open as far as this server is concerned,
    // and failing the admin's request now would leave the two sides disagreeing about that.
    console.error(
      "[chain] failed to publish election configuration:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Turnout and ledger-derived figures for the monitoring screen. */
export interface MonitoringSnapshot {
  election: Election;
  counts: ElectionCounts;
  rings: { total: number; published: number };
  rejectedSubmissions: number | null;
  /** Per-candidate totals, only once voting has closed. */
  tally: Record<string, number> | null;
}

/**
 * Everything the monitoring screen shows.
 *
 * Note what is not here and cannot be: there is no per-candidate count while voting is open,
 * because this server holds no ballots to count. The tally is read from the ledger, and only
 * after voting closes — before that, a running total would be a live partial result that
 * nobody is entitled to see, and this server could not produce one even if asked.
 */
export async function getMonitoringSnapshot(id: string): Promise<MonitoringSnapshot> {
  const election = await getElection(id);

  const ledger = chainFor(election);
  const [counts, ringSizes, rejected] = await Promise.all([
    countsForElection(election.id),
    listRingsWithSizes(election.id),
    ledger.getRejectedCount(election.id).catch(() => null),
  ]);

  const tally =
    election.status === "VOTING_CLOSED" || election.status === "TALLIED"
      ? await ledger.getTally(election.id).catch(() => null)
      : null;


  return {
    election,
    counts,
    rings: {
      total: ringSizes.length,
      published: ringSizes.filter((entry) => entry.ring.publishedAt !== null).length,
    },
    rejectedSubmissions: rejected,
    tally,
  };
}
