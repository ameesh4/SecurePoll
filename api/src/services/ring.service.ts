import { createHash, randomInt } from "crypto";
import { env } from "../config/env";
import { db } from "../db/drizzle";
import { recordAuditEntry } from "../db/repository/auditLog.repository";
import {
  countUnassignedVoters,
  findElectionById,
  lockElectionById,
} from "../db/repository/elections.repository";
import { listEligibleVoters } from "../db/repository/eligibility.repository";
import {
  deleteUnpublishedRings,
  insertRingMembers,
  insertRings,
  listRingMembers,
  listRingsWithSizes,
  markRingPublished,
} from "../db/repository/rings.repository";
import { AuditAction, type Election, type Voter } from "../db/schema";
import { ConflictError, NotFoundError } from "../lib/errors";
import { listCandidatesInOrder } from "./candidate.service";
import { evaluatePublishGuards, type GuardReport } from "./guards.service";
import { assertOperationAllowed, assertSuperAdmin } from "./lifecycle";

/**
 * Formation of anonymity groups — "rings" in the LSAG literature.
 *
 * A ring is the set of public keys a ballot is signed on behalf of. Its size *is* the privacy
 * guarantee: a signature proves only that one of the n keys produced it, so a ring of n gives
 * a voter a 1-in-n denial. A ring of one is a signature with the voter's name on it. Every
 * rule below follows from that single fact.
 */

/**
 * Unbiased Fisher-Yates over a cryptographic source.
 *
 * `crypto.randomInt` is used rather than `Math.random` for two independent reasons, and both
 * matter. `Math.random` is not a CSPRNG, so its output is predictable from enough observed
 * samples — and the published rings *are* observable. It is also biased when squeezed into a
 * range by multiplication. Either flaw lets an observer reconstruct the permutation, and the
 * permutation is what decides who a voter is hidden among; recovering it narrows a ring back
 * towards a single name.
 */
function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    const a = result[i]!;
    const b = result[j]!;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/**
 * Partitions a shuffled electorate into groups.
 *
 * The remainder is the interesting part. `n` voters rarely divide evenly by the target size,
 * and the naive answer — a final short group — is the one thing that must not happen: with
 * 3,204 voters and a target of 10, the leftover group would hold 4 people, and those four
 * would each have a 1-in-4 denial while everyone else had 1-in-10. Worse, at a remainder of 1
 * the "ring" identifies its member outright.
 *
 * So the leftovers are dealt one each into the existing groups instead, producing sizes of
 * `target` and `target + 1`. Nobody ends up below the floor, and the cost is that a handful
 * of voters get slightly *better* anonymity than the target.
 */
function partition(count: number, target: number): number[] {
  const groups = Math.floor(count / target);
  if (groups === 0) return [];

  const sizes = new Array<number>(groups).fill(target);
  let leftover = count - groups * target;
  for (let i = 0; leftover > 0; i = (i + 1) % groups) {
    sizes[i] = sizes[i]! + 1;
    leftover -= 1;
  }
  return sizes;
}

/**
 * A short checksum of a formation, shown to the admin as "shuffle 7f2c".
 *
 * Derived from the grouping itself rather than being a random label, so it is verifiable: two
 * people reading the same fingerprint are looking at the same assignment, and re-forming
 * visibly changes it. It is a checksum for human cross-reference, not a security boundary.
 */
function fingerprint(groups: readonly (readonly string[])[]): string {
  const hash = createHash("sha256");
  for (const [index, keys] of groups.entries()) {
    hash.update(`${index}:`);
    for (const key of keys) hash.update(`${key},`);
  }
  return hash.digest("hex").slice(0, 4);
}

export interface RingPreviewGroup {
  index: number;
  size: number;
  /**
   * How many of this group's members are redistributed leftovers. Derivable rather than
   * stored: leftovers are appended after the base chunk, so any position at or beyond the
   * target size is one. Shown so the admin can see the remainder was absorbed, not dropped.
   */
  redistributed: number;
  published: boolean;
  ringId?: string;
}

export interface RingPreview {
  electionId: string;
  targetSize: number;
  minimumSize: number;
  voters: number;
  groups: number;
  smallestSize: number;
  largestSize: number;
  unassignedVoters: number;
  redistributedVoters: number;
  fingerprint: string;
  /** Publication makes membership permanent, so it is reported explicitly. */
  published: boolean;
  publishedGroups: number;
  warnings: string[];
  /** A window onto the groups; the full list is paginated separately. */
  sample: RingPreviewGroup[];
}

const SAMPLE_SIZE = 24;

function assertFormable(election: Election, voterCount: number): void {
  if (election.ringSize < env.RING_MIN_SIZE) {
    throw new ConflictError(
      `This election's group size (${election.ringSize}) is below the minimum of ${env.RING_MIN_SIZE}`,
    );
  }
  if (voterCount < env.RING_MIN_SIZE) {
    throw new ConflictError(
      `${voterCount} approved voters is not enough to form a group of at least ${env.RING_MIN_SIZE}. ` +
        "Publishing a smaller group would identify its members.",
      { voters: voterCount, minimum: env.RING_MIN_SIZE },
    );
  }
}

/**
 * What forming groups *would* produce, without writing anything.
 *
 * Runs the same partition arithmetic as the real formation so the numbers on screen are the
 * numbers the admin will get. It does not run the same shuffle — the shuffle is regenerated
 * when formation actually happens, so the fingerprint shown here is of the hypothetical sizes
 * only and is reported as such.
 */
export async function previewFormation(electionId: string): Promise<RingPreview> {
  const election = await findElectionById(electionId);
  if (!election) throw new NotFoundError("Election not found");

  const [voters, existing] = await Promise.all([
    listEligibleVoters(electionId),
    listRingsWithSizes(electionId),
  ]);

  // Once groups exist, the preview describes what is actually on the table rather than a
  // fresh hypothetical — that is what the admin is being asked to freeze.
  if (existing.length > 0) {
    return describeExisting(election, voters.length);
  }

  assertFormable(election, voters.length);
  const sizes = partition(voters.length, election.ringSize);

  const warnings: string[] = [];
  const redistributed = sizes.reduce(
    (total, size) => total + Math.max(0, size - election.ringSize),
    0,
  );
  if (redistributed > 0) {
    warnings.push(
      `${redistributed} leftover voters will be distributed into existing groups rather than published as an undersized group.`,
    );
  }

  return {
    electionId,
    targetSize: election.ringSize,
    minimumSize: env.RING_MIN_SIZE,
    voters: voters.length,
    groups: sizes.length,
    smallestSize: sizes.length ? Math.min(...sizes) : 0,
    largestSize: sizes.length ? Math.max(...sizes) : 0,
    unassignedVoters: 0,
    redistributedVoters: redistributed,
    fingerprint: "—",
    published: false,
    publishedGroups: 0,
    warnings,
    sample: sizes.slice(0, SAMPLE_SIZE).map((size, index) => ({
      index,
      size,
      redistributed: Math.max(0, size - election.ringSize),
      published: false,
    })),
  };
}

async function describeExisting(
  election: Election,
  voterCount: number,
): Promise<RingPreview> {
  const [groups, unassigned] = await Promise.all([
    listRingsWithSizes(election.id),
    countUnassignedVoters(election.id),
  ]);

  const sizes = groups.map((entry) => entry.size);
  const published = groups.filter((entry) => entry.ring.publishedAt !== null);

  // The fingerprint is over real membership, so it identifies this exact assignment.
  const memberKeys = await Promise.all(
    groups.map(async (entry) =>
      (await listRingMembers(entry.ring.id)).map((member) => member.publicKey),
    ),
  );

  const redistributed = sizes.reduce(
    (total, size) => total + Math.max(0, size - election.ringSize),
    0,
  );

  const warnings: string[] = [];
  if (unassigned > 0) {
    warnings.push(
      `${unassigned} approved voters are not in any group. They could not cast a countable ballot.`,
    );
  }
  const smallest = sizes.length ? Math.min(...sizes) : 0;
  if (sizes.length > 0 && smallest < env.RING_MIN_SIZE) {
    warnings.push(
      `The smallest group has ${smallest} members, below the minimum of ${env.RING_MIN_SIZE}.`,
    );
  }
  if (published.length > 0 && published.length < groups.length) {
    warnings.push(
      `${published.length} of ${groups.length} groups are already published. Re-forming is no longer possible.`,
    );
  }

  return {
    electionId: election.id,
    targetSize: election.ringSize,
    minimumSize: env.RING_MIN_SIZE,
    voters: voterCount,
    groups: groups.length,
    smallestSize: smallest,
    largestSize: sizes.length ? Math.max(...sizes) : 0,
    unassignedVoters: unassigned,
    redistributedVoters: redistributed,
    fingerprint: fingerprint(memberKeys),
    published: published.length > 0,
    publishedGroups: published.length,
    warnings,
    sample: groups.slice(0, SAMPLE_SIZE).map((entry) => ({
      index: entry.ring.index,
      size: entry.size,
      redistributed: Math.max(0, entry.size - election.ringSize),
      published: entry.ring.publishedAt !== null,
      ringId: entry.ring.id,
    })),
  };
}

/**
 * Forms (or re-forms) the anonymity groups for an election.
 *
 * Re-forming is allowed right up until the first group is published, and refused after. This
 * is the hard boundary in the whole feature: a published ring is what already-cast signatures
 * verify against, so deleting and rebuilding one does not "undo" the publication — it strands
 * every ballot made against it, undetectably, and there is no repair.
 *
 * The voter's public key is copied into the membership row rather than joined from `voters`.
 * If it were resolved at read time, a voter rotating their key would silently rewrite an
 * already-published ring and every signature against it would stop verifying.
 */
export async function formRings(
  electionId: string,
  adminId: string,
): Promise<RingPreview> {
  await db.transaction(async (tx) => {
    const election = await lockElectionById(electionId, tx);
    if (!election) throw new NotFoundError("Election not found");
    assertOperationAllowed("formRings", election);

    const existing = await listRingsWithSizes(electionId, tx);
    if (existing.some((entry) => entry.ring.publishedAt !== null)) {
      throw new ConflictError(
        "Groups for this election have already been published and cannot be re-formed. " +
          "Ballots are verified against the published membership.",
      );
    }

    const voters = await listEligibleVoters(electionId, tx);
    assertFormable(election, voters.length);

    await deleteUnpublishedRings(electionId, tx);

    const shuffled = shuffle(voters);
    const sizes = partition(shuffled.length, election.ringSize);

    const created = await insertRings(
      sizes.map((_size, index) => ({ electionId, index })),
      tx,
    );

    const members: {
      ringId: string;
      electionId: string;
      voterId: string;
      positionInRing: number;
      publicKey: string;
    }[] = [];

    let cursor = 0;
    for (const [groupIndex, size] of sizes.entries()) {
      const ring = created[groupIndex];
      if (!ring) throw new Error("Ring insert returned fewer rows than requested");

      for (let position = 0; position < size; position += 1) {
        const voter = shuffled[cursor] as Voter | undefined;
        if (!voter) throw new Error("Ran out of voters while filling groups");
        cursor += 1;
        members.push({
          ringId: ring.id,
          electionId,
          voterId: voter.id,
          positionInRing: position,
          publicKey: voter.publicKey,
        });
      }
    }

    // The partition consumes every voter by construction, but a silent off-by-one here would
    // disenfranchise whoever was left over, so it is asserted rather than assumed.
    if (cursor !== shuffled.length) {
      throw new Error(
        `Formation would leave ${shuffled.length - cursor} voters unassigned`,
      );
    }

    await insertRingMembers(members, tx);

    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.RingsFormed,
        entityType: "election",
        entityId: electionId,
        electionId,
        before: { groups: existing.length },
        after: {
          groups: sizes.length,
          voters: shuffled.length,
          targetSize: election.ringSize,
          sizes: { smallest: Math.min(...sizes), largest: Math.max(...sizes) },
        },
      },
      tx,
    );
  });

  return previewFormation(electionId);
}

/** Read-only pre-flight for the freeze-and-publish dialog. */
export async function previewPublish(electionId: string): Promise<GuardReport> {
  const election = await findElectionById(electionId);
  if (!election) throw new NotFoundError("Election not found");
  return evaluatePublishGuards(election);
}

/**
 * The election manifest — how candidates and anonymity groups reach the ledger nodes.
 *
 * Format and rules: `blockchain/ELECTION_MANIFEST.md`. Consumed by `ElectionManifest::load`
 * in `blockchain/src/election.rs`.
 *
 * Field order here is deliberate and must not be rearranged: `serializeManifest` relies on
 * insertion order to produce stable bytes, and the digest of those bytes is what gets recorded
 * as each ring's `chainTxRef`.
 */
export interface ChainManifest {
  version: 1;
  electionId: string;
  title: string;
  votingOpensAt: string | null;
  votingClosesAt: string | null;
  ringSize: number;
  candidates: {
    candidateId: string;
    name: string;
    affiliation: string | null;
    ballotPosition: number;
  }[];
  rings: {
    ringId: string;
    index: number;
    /** Ordered by `positionInRing`. Never sort or deduplicate — see below. */
    publicKeys: string[];
  }[];
}

export interface ChainManifestExport {
  manifest: ChainManifest;
  /** Exact bytes a node will read, and what `digest` is computed over. */
  serialized: string;
  /** `sha256:<hex>` over `serialized`. Reproducible by anyone holding the file. */
  digest: string;
}

/** Stable serialization: two exports of the same election produce identical bytes. */
export function serializeManifest(manifest: ChainManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function manifestDigest(serialized: string): string {
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

/**
 * Builds the manifest for an election — and, the first time it is generated, freezes group
 * membership by publishing every group.
 *
 * There is no separate "push to the ledger" step (`api/src/lib/chain/http.ts` deliberately
 * throws rather than inventing one): nodes import this file from disk, so exporting it *is*
 * how a group's membership reaches a node. That is also why the digest computed below — not a
 * response from a chain adapter — is what `chainTxRef` records: nothing else can hand back
 * proof of what was published, because nothing else is where the published bytes exist.
 *
 * Freezing therefore happens inline here, gated exactly as the old dedicated "publish" action
 * was: a super-admin, and every check in `evaluatePublishGuards`, so a reviewer or an
 * incomplete electorate is refused. Every export after the first is a plain re-read — a
 * published ring cannot become unassigned or undersized, so the guard cannot newly fail.
 *
 * Reads the same way the old publish step did — `listRingsWithSizes` then `listRingMembers`
 * per group — because that is the path that already guarantees members come back in
 * `positionInRing` order. `listRingDetails` is not used here: it paginates and omits members.
 *
 * **Ring order is cryptographic.** Every challenge in an LSAG signature hashes the whole ring
 * in sequence, so reordering `publicKeys` invalidates every ballot signed against that group,
 * silently. The order arrives correct from the repository and is passed through untouched.
 */
export async function exportChainManifest(
  electionId: string,
  admin: { id: string; role: string },
): Promise<ChainManifestExport> {
  const election = await findElectionById(electionId);
  if (!election) throw new NotFoundError("Election not found");

  assertOperationAllowed("exportChainManifest", election);

  const [groups, candidateList] = await Promise.all([
    listRingsWithSizes(electionId),
    listCandidatesInOrder(electionId),
  ]);

  if (groups.length === 0) {
    throw new ConflictError(
      "This election has no anonymity groups yet, so there is nothing for a ledger node to " +
        "verify ballots against.",
    );
  }

  const candidates = candidateList.candidates.map((candidate) => ({
    candidateId: candidate.id,
    name: candidate.name,
    affiliation: candidate.affiliation,
    ballotPosition: candidate.ballotPosition,
  }));
  if (candidates.length === 0) {
    throw new ConflictError(
      "This election has no candidates, so a ledger node would reject every ballot.",
    );
  }

  const rings: ChainManifest["rings"] = [];
  for (const entry of groups) {
    const members = await listRingMembers(entry.ring.id);
    rings.push({
      ringId: entry.ring.id,
      index: entry.ring.index,
      publicKeys: members.map((member) => member.publicKey),
    });
  }

  const manifest: ChainManifest = {
    version: 1,
    electionId: election.id,
    title: election.title,
    votingOpensAt: election.votingOpensAt?.toISOString() ?? null,
    votingClosesAt: election.votingClosesAt?.toISOString() ?? null,
    ringSize: election.ringSize,
    candidates,
    rings,
  };

  const serialized = serializeManifest(manifest);
  const digest = manifestDigest(serialized);

  const unpublished = groups.filter((entry) => entry.ring.publishedAt === null);
  if (unpublished.length > 0) {
    assertSuperAdmin(admin.role, "Freezing and publishing anonymity groups");

    const guards = await evaluatePublishGuards(election);
    if (!guards.passed) {
      const failed = guards.checks.filter((check) => !check.passed);
      throw new ConflictError(
        `These groups are not ready to publish: ${failed
          .map((check) => check.label)
          .join("; ")}`,
        { checks: guards.checks },
      );
    }

    for (const entry of unpublished) {
      await markRingPublished(entry.ring.id, digest, db);
    }

    await recordAuditEntry({
      adminId: admin.id,
      action: AuditAction.RingsPublished,
      entityType: "election",
      entityId: electionId,
      electionId,
      before: { published: groups.length - unpublished.length },
      after: { published: groups.length, total: groups.length },
    });
  }

  await recordAuditEntry({
    adminId: admin.id,
    action: AuditAction.ChainManifestExported,
    entityType: "election",
    entityId: electionId,
    electionId,
    before: null,
    after: {
      digest,
      groups: rings.length,
      publicKeys: rings.reduce((total, ring) => total + ring.publicKeys.length, 0),
      candidates: candidates.length,
    },
  });

  return { manifest, serialized, digest };
}

export interface RingDetail {
  index: number;
  ringId: string;
  size: number;
  published: boolean;
  publishedAt: Date | null;
  chainTxRef: string | null;
  redistributed: number;
}

export async function listRingDetails(
  electionId: string,
  page: number,
  pageSize: number,
): Promise<{ rows: RingDetail[]; total: number }> {
  const election = await findElectionById(electionId);
  if (!election) throw new NotFoundError("Election not found");

  const groups = await listRingsWithSizes(electionId);
  const start = (page - 1) * pageSize;

  return {
    total: groups.length,
    rows: groups.slice(start, start + pageSize).map((entry) => ({
      index: entry.ring.index,
      ringId: entry.ring.id,
      size: entry.size,
      published: entry.ring.publishedAt !== null,
      publishedAt: entry.ring.publishedAt,
      chainTxRef: entry.ring.chainTxRef,
      redistributed: Math.max(0, entry.size - election.ringSize),
    })),
  };
}
