import { db } from "../db/drizzle";
import { recordAuditEntry } from "../db/repository/auditLog.repository";
import {
  createCandidate,
  deleteCandidate,
  findCandidateById,
  listCandidates,
  nextBallotPosition,
  updateCandidate,
} from "../db/repository/candidates.repository";
import { lockElectionById } from "../db/repository/elections.repository";
import type { Executor } from "../db/executor";
import { AuditAction, type Candidate } from "../db/schema";
import { asConflictError } from "../lib/conflicts";
import { ConflictError, NotFoundError } from "../lib/errors";
import { assertOperationAllowed } from "./lifecycle";

/**
 * Ballot positions are validated to stay well below this, so shifting the whole list up by it
 * is guaranteed to land in unoccupied numbers. Used by the reorder below.
 */
const REORDER_OFFSET = 10_000;

export interface CandidateInput {
  name: string;
  affiliation?: string | null;
  photoUrl?: string | null;
  ballotPosition?: number;
}

export interface CandidateList {
  candidates: Candidate[];
  /** Voting cannot open on an election with fewer than two names. */
  belowMinimum: boolean;
}

/** The candidates in ballot order, which is how the ballot itself reads. */
export async function listCandidatesInOrder(
  electionId: string,
): Promise<CandidateList> {
  const candidates = await listCandidates(electionId);
  return { candidates, belowMinimum: candidates.length < 2 };
}

const POSITION_TAKEN = "Another candidate already holds that ballot position";

/**
 * Loads the election with a lock and refuses if candidates are no longer editable.
 *
 * Immutability from RINGS_FROZEN onwards is not a policy preference. The message a voter
 * signs is the canonical encoding of `{ electionId, ringId, candidateId }`, so a candidate id
 * is inside the signature. Deleting a candidate after ballots exist orphans every vote cast
 * for them; re-pointing a row at a different person silently reassigns those votes. Neither
 * is detectable afterwards from the ledger alone.
 */
async function assertEditable(electionId: string, executor: Executor) {
  const election = await lockElectionById(electionId, executor);
  if (!election) throw new NotFoundError("Election not found");
  assertOperationAllowed("manageCandidates", election);
  return election;
}

export async function addCandidate(
  electionId: string,
  input: CandidateInput,
  adminId: string,
): Promise<Candidate> {
  return db.transaction(async (tx) => {
    await assertEditable(electionId, tx);

    const ballotPosition =
      input.ballotPosition ?? (await nextBallotPosition(electionId, tx));

    let candidate: Candidate;
    try {
      candidate = await createCandidate(
        {
          electionId,
          name: input.name.trim(),
          affiliation: input.affiliation?.trim() || null,
          photoUrl: input.photoUrl?.trim() || null,
          ballotPosition,
        },
        tx,
      );
    } catch (error) {
      const conflict = asConflictError(error, POSITION_TAKEN);
      if (conflict) throw conflict;
      throw error;
    }

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.CandidateAdded,
        entityType: "candidate",
        entityId: candidate.id,
        electionId,
        before: null,
        after: {
          name: candidate.name,
          ballotPosition: candidate.ballotPosition,
        },
      },
      tx,
    );

    return candidate;
  });
}

function candidateSnapshot(candidate: Candidate) {
  return {
    name: candidate.name,
    affiliation: candidate.affiliation,
    ballotPosition: candidate.ballotPosition,
  };
}

export async function editCandidate(
  candidateId: string,
  input: Partial<CandidateInput>,
  adminId: string,
): Promise<Candidate> {
  return db.transaction(async (tx) => {
    const existing = await findCandidateById(candidateId, tx);
    if (!existing) throw new NotFoundError("Candidate not found");
    await assertEditable(existing.electionId, tx);

    let updated: Candidate;
    try {
      updated = await updateCandidate(
        candidateId,
        {
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(input.affiliation === undefined
            ? {}
            : { affiliation: input.affiliation?.trim() || null }),
          ...(input.photoUrl === undefined
            ? {}
            : { photoUrl: input.photoUrl?.trim() || null }),
          ...(input.ballotPosition === undefined
            ? {}
            : { ballotPosition: input.ballotPosition }),
        },
        tx,
      );
    } catch (error) {
      const conflict = asConflictError(error, POSITION_TAKEN);
      if (conflict) throw conflict;
      throw error;
    }

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.CandidateUpdated,
        entityType: "candidate",
        entityId: candidateId,
        electionId: existing.electionId,
        before: candidateSnapshot(existing),
        after: candidateSnapshot(updated),
      },
      tx,
    );

    return updated;
  });
}

export async function removeCandidate(
  candidateId: string,
  adminId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await findCandidateById(candidateId, tx);
    if (!existing) throw new NotFoundError("Candidate not found");
    await assertEditable(existing.electionId, tx);

    await deleteCandidate(candidateId, tx);

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.CandidateRemoved,
        entityType: "candidate",
        entityId: candidateId,
        electionId: existing.electionId,
        before: candidateSnapshot(existing),
        after: null,
      },
      tx,
    );
  });
}

/**
 * Rewrites the ballot order.
 *
 * Applied as a whole list rather than one candidate at a time because positions are unique
 * per election: swapping two candidates with two separate updates collides on the intermediate
 * state. Every row is therefore parked at `position + REORDER_OFFSET` first, which vacates
 * the low numbers entirely before any row claims its new one. (Negatives would be the obvious
 * parking spot, but the table's check constraint requires positions to be positive — the
 * constraint is right and the workaround is to move up rather than down.)
 */
export async function reorderCandidates(
  electionId: string,
  orderedCandidateIds: readonly string[],
  adminId: string,
): Promise<Candidate[]> {
  return db.transaction(async (tx) => {
    await assertEditable(electionId, tx);

    const existing = await listCandidates(electionId, tx);

    if (existing.length !== orderedCandidateIds.length) {
      throw new ConflictError(
        "The reorder must list every candidate for this election exactly once",
        { expected: existing.length, received: orderedCandidateIds.length },
      );
    }

    const known = new Set(existing.map((candidate) => candidate.id));
    for (const id of orderedCandidateIds) {
      if (!known.has(id)) {
        throw new ConflictError("That candidate does not belong to this election");
      }
    }

    for (const [index, id] of orderedCandidateIds.entries()) {
      await updateCandidate(id, { ballotPosition: REORDER_OFFSET + index + 1 }, tx);
    }
    for (const [index, id] of orderedCandidateIds.entries()) {
      await updateCandidate(id, { ballotPosition: index + 1 }, tx);
    }

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.CandidateUpdated,
        entityType: "election",
        entityId: electionId,
        electionId,
        before: { order: existing.map((candidate) => candidate.id) },
        after: { order: [...orderedCandidateIds] },
      },
      tx,
    );

    return listCandidates(electionId, tx);
  });
}
