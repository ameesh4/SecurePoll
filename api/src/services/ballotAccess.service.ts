import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { env } from "../config/env";
import { db } from "../db/drizzle";
import { recordAuditEntry } from "../db/repository/auditLog.repository";
import {
  claimPendingTokens,
  consumeResendAllowance,
  findTokenById,
  insertTokens,
  listTokens,
  lockTokenByHash,
  markTokenRedeemed,
  recordDeliveryAttempt,
  rotateTokenHash,
  summariseDispatch,
  updateRecipient,
  type DispatchSummary,
  type TokenListQuery,
  type TokenRow,
} from "../db/repository/ballotAccessTokens.repository";
import { listCandidates } from "../db/repository/candidates.repository";
import { findElectionById, lockElectionById } from "../db/repository/elections.repository";
import { listEligibleVoters } from "../db/repository/eligibility.repository";
import { findRingForVoter, listRingMembers } from "../db/repository/rings.repository";
import { findVoterById } from "../db/repository/voters.repository";
import { AuditAction, type BallotAccessToken, type Election } from "../db/schema";
import { saveDemoToken } from "../lib/demoTokenStore";
import { AppError, ConflictError, NotFoundError, UnauthorizedError } from "../lib/errors";
import { mailer } from "../lib/mailer";
import { ballotAccessEmail } from "../lib/mailer/templates";
import { assertOperationAllowed, assertSuperAdmin } from "./lifecycle";

const TOKEN_BYTES = 32;

/**
 * Mints a bearer credential.
 *
 * 32 bytes of CSPRNG output, so there is nothing to guess: the search space is 2^256 and the
 * token carries no structure, no voter id, no timestamp. The hash stored alongside is a plain
 * SHA-256 rather than a password KDF, which is correct for this input — a slow hash exists to
 * frustrate dictionary attacks on low-entropy secrets, and there is no dictionary for 32
 * random bytes.
 */
function mintToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The lookup is by hash so the database does the matching, but where a presented value is
 * compared in application code it is compared this way: a byte-by-byte early return leaks how
 * much of a guess was correct, and a credential that can be extended one byte at a time is not
 * a credential.
 */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function ballotUrl(token: string): string {
  return `${env.VOTER_APP_BASE_URL.replace(/\/$/, "")}/ballot?access=${encodeURIComponent(token)}`;
}

function expiryFor(election: Election): Date {
  if (election.votingClosesAt) return election.votingClosesAt;
  // A credential with no expiry is a credential that works forever. When the election has no
  // close time recorded yet, fall back to a short window rather than an open-ended one.
  const fallback = new Date();
  fallback.setDate(fallback.getDate() + 7);
  return fallback;
}

/**
 * Delivers one credential and records the outcome.
 *
 * Note that a fresh token is minted on every send. This follows from storing only the hash:
 * the plaintext exists in exactly one outbound email and nowhere else, so a re-send cannot
 * repeat the previous token — it has to replace it. That is the safer behaviour anyway. Any
 * link from an earlier attempt stops working, so a credential that went to a stale or wrong
 * address is revoked by the act of correcting it, and a voter never holds two live links.
 */
async function rotateAndDeliver(
  token: BallotAccessToken,
  election: Election,
  voterName: string,
): Promise<void> {
  const minted = mintToken();
  await rotateTokenHash(token.id, minted.tokenHash);
  console.log(`[ballot-access] delivering token ${minted.token} to ${token.deliverTo} for election ${election.id}`);
  console.log(`[ballot-access] link ${ballotUrl(minted.token)}`);
  // Dev/demo only — see demoTokenStore.ts. Lets `bun run vote` pick up a live token without a
  // browser or a real inbox.
  saveDemoToken({
    voterId: token.voterId,
    electionId: token.electionId,
    deliverTo: token.deliverTo,
    token: minted.token,
    expiresAt: token.expiresAt.toISOString(),
  });
  try {
    await mailer.send(
      ballotAccessEmail({
        to: token.deliverTo,
        fullName: voterName,
        electionTitle: election.title,
        ballotUrl: ballotUrl(minted.token),
        expiresAt: token.expiresAt,
      }),
    );
    await recordDeliveryAttempt(token.id, { status: "SENT" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A hard bounce and a transient failure are different states to an admin: one needs the
    // address corrected, the other just needs retrying.
    const bounced = /55\d|mailbox|no such user|does not exist/i.test(reason);
    await recordDeliveryAttempt(token.id, {
      status: bounced ? "BOUNCED" : "FAILED",
      error: reason,
    });
  }
}

export interface IssueOutcome {
  issued: number;
  skipped: number;
  queued: number;
}

/**
 * Mints one credential per eligible voter who does not already hold one.
 *
 * Issuing is separated from sending on purpose. Dispatching thousands of emails inside the
 * admin's HTTP request would hold the connection open for minutes and lose the whole batch if
 * it timed out; instead the rows are written with `PENDING` status and a background pass works
 * through them, so every recipient has an individually visible and individually retryable
 * state.
 */
export async function issueTokens(
  electionId: string,
  admin: { id: string; role: string },
): Promise<IssueOutcome> {
  const outcome = await db.transaction(async (tx) => {
    const election = await lockElectionById(electionId, tx);
    if (!election) throw new NotFoundError("Election not found");
    assertOperationAllowed("issueTokens", election);
    /**
     * Super-admin only, unlike an individual resend.
     *
     * This mints a live voting credential for every approved voter and puts it in the post. Email
     * cannot be recalled, so a batch sent by mistake — to the wrong election, or before the roll was
     * final — is not something an undo button can fix. Resending or re-addressing one recipient is a
     * support task and stays open to reviewers.
     */
    assertSuperAdmin(admin.role, "Issuing ballot access to an electorate");

    const voters = await listEligibleVoters(electionId, tx);
    if (voters.length === 0) {
      throw new ConflictError("This election has no approved voters to issue access to");
    }

    const expiresAt = expiryFor(election);
    const created = await insertTokens(
      voters.map((voter) => ({
        electionId,
        voterId: voter.id,
        ...mintToken(),
        expiresAt,
        deliverTo: voter.email,
      })),
      tx,
    );

    await recordAuditEntry(
      {
        adminId: admin.id,
        action: AuditAction.TokensIssued,
        entityType: "election",
        entityId: electionId,
        electionId,
        before: null,
        after: {
          issued: created.length,
          electorate: voters.length,
          expiresAt,
        },
      },
      tx,
    );

    return {
      issued: created.length,
      skipped: voters.length - created.length,
      queued: created.length,
    };
  });

  // Deliberately not awaited: the admin gets their response as soon as the credentials exist,
  // and delivery progress is visible on the dispatch screen.
  void dispatchPending(electionId).catch((error: unknown) => {
    console.error(
      "[ballot-access] dispatch pass failed:",
      error instanceof Error ? error.message : error,
    );
  });

  return outcome;
}

/**
 * Sends the next batch of pending credentials.
 *
 * Bounded per call so one pass cannot occupy the process indefinitely, and safe to call again:
 * rows leave `PENDING` as they are attempted, so a second pass picks up where this one stopped.
 */
export async function dispatchPending(electionId: string): Promise<{ attempted: number }> {
  const election = await findElectionById(electionId);
  if (!election) throw new NotFoundError("Election not found");

  const pending = await claimPendingTokens(electionId, env.TOKEN_DISPATCH_BATCH_SIZE);
  let attempted = 0;

  for (const token of pending) {
    const voter = await findVoterById(token.voterId);
    if (!voter) continue;
    await rotateAndDeliver(token, election, voter.fullName);
    attempted += 1;
  }

  return { attempted };
}

export async function resendToken(
  tokenId: string,
  adminId: string,
): Promise<{ status: string }> {
  const token = await findTokenById(tokenId);
  if (!token) throw new NotFoundError("Ballot access record not found");

  if (token.redeemedAt) {
    throw new ConflictError(
      "This voter has already collected their ballot, so their access link has been used and cannot be re-sent.",
    );
  }
  if (token.expiresAt <= new Date()) {
    throw new ConflictError("This access link has expired and cannot be re-sent");
  }

  const allowed = await consumeResendAllowance(tokenId, {
    max: env.TOKEN_RESEND_MAX,
    windowMs: env.TOKEN_RESEND_WINDOW_MINUTES * 60 * 1000,
  });
  if (!allowed) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      `This voter has already been sent ${env.TOKEN_RESEND_MAX} links in the last ${env.TOKEN_RESEND_WINDOW_MINUTES} minutes`,
    );
  }

  const [election, voter] = await Promise.all([
    findElectionById(token.electionId),
    findVoterById(token.voterId),
  ]);
  if (!election || !voter) throw new NotFoundError("Election or voter not found");

  await rotateAndDeliver(allowed, election, voter.fullName);

  await recordAuditEntry({
    adminId,
    action: AuditAction.TokenResent,
    entityType: "ballot_access_token",
    entityId: tokenId,
    electionId: token.electionId,
    before: { emailStatus: token.emailStatus, attempts: token.deliveryAttempts },
    after: { deliverTo: allowed.deliverTo },
  });

  const refreshed = await findTokenById(tokenId);
  return { status: refreshed?.emailStatus ?? "PENDING" };
}

/**
 * Corrects the address a credential is sent to, after a bounce.
 *
 * Only the delivery address changes. The voter's identity record is untouched, so the audit
 * trail still shows where the failed attempt went, and the credential itself is rotated on the
 * next send — a link that reached a wrong inbox stops working.
 */
export async function changeRecipient(
  tokenId: string,
  email: string,
  adminId: string,
): Promise<BallotAccessToken> {
  const token = await findTokenById(tokenId);
  if (!token) throw new NotFoundError("Ballot access record not found");
  if (token.redeemedAt) {
    throw new ConflictError("This access link has already been used");
  }

  const updated = await updateRecipient(tokenId, email.trim().toLowerCase());

  await recordAuditEntry({
    adminId,
    action: AuditAction.TokenRecipientChanged,
    entityType: "ballot_access_token",
    entityId: tokenId,
    electionId: token.electionId,
    before: { deliverTo: token.deliverTo, emailStatus: token.emailStatus },
    after: { deliverTo: updated.deliverTo, emailStatus: updated.emailStatus },
  });

  return updated;
}

/** Re-queues everything that failed, so one click covers a whole batch of transient errors. */
export async function retryFailed(
  electionId: string,
  adminId: string,
): Promise<{ requeued: number }> {
  const election = await findElectionById(electionId);
  if (!election) throw new NotFoundError("Election not found");

  const { rows } = await listTokens({
    electionId,
    status: "FAILED",
    page: 1,
    pageSize: env.TOKEN_DISPATCH_BATCH_SIZE,
  });

  for (const row of rows) {
    await rotateAndDeliver(row.token, election, row.voter.fullName);
  }

  if (rows.length > 0) {
    await recordAuditEntry({
      adminId,
      action: AuditAction.TokenResent,
      entityType: "election",
      entityId: electionId,
      electionId,
      before: { failed: rows.length },
      after: { requeued: rows.length },
    });
  }

  return { requeued: rows.length };
}

export interface DispatchView {
  summary: DispatchSummary;
  rows: TokenRow[];
  total: number;
  page: number;
  pageSize: number;
  resendLimit: { max: number; windowMinutes: number };
  expiresAt: Date | null;
}

export async function getDispatchView(query: TokenListQuery): Promise<DispatchView> {
  const election = await findElectionById(query.electionId);
  if (!election) throw new NotFoundError("Election not found");

  const [summary, page] = await Promise.all([
    summariseDispatch(query.electionId),
    listTokens(query),
  ]);

  return {
    summary,
    rows: page.rows,
    total: page.total,
    page: query.page,
    pageSize: query.pageSize,
    resendLimit: {
      max: env.TOKEN_RESEND_MAX,
      windowMinutes: env.TOKEN_RESEND_WINDOW_MINUTES,
    },
    expiresAt: election.votingClosesAt,
  };
}

export interface RingRetrieval {
  electionId: string;
  electionTitle: string;
  ringId: string;
  /**
   * Where to send the signed ballot: the root node of *this election's* ledger network.
   *
   * Returned here rather than configured in the client because every election runs its own
   * separate network, so no single baked-in address could serve them all. It discloses nothing
   * new — the caller is already receiving the ring itself. Null when no ledger has been recorded
   * for the election yet, in which case there is nowhere to cast a ballot.
   */
  nodeUrl: string | null;
  /** Ordered exactly as published. The client locates its own key in this list. */
  publicKeys: string[];
  candidates: {
    id: string;
    name: string;
    affiliation: string | null;
    photoUrl: string | null;
    ballotPosition: number;
  }[];
}

/**
 * Handles `POST /api/ring` — the one and only thing a ballot-access credential authorises.
 *
 * The credential never travels any further than this call. What comes back is the ring the bearer
 * belongs to, and deliberately **not** their index in it: the client already knows its own key
 * and can find it, whereas an index returned by this server would be a record, in a request this
 * server logs, of exactly which member of the ring was about to sign. That single field would
 * undo the anonymity the ring exists to provide.
 *
 * Nothing about the ballot passes through here either — no vote, no signature, no key image.
 * The vote package goes from the voter's device straight to a ledger node.
 *
 * **Retrieval is idempotent until the token expires.** A voter who closes the tab, loses their
 * connection mid-submission, or reloads the page can collect their ring again rather than being
 * locked out pending an admin resend. This does not weaken anything: the ring is published to the
 * ledger regardless, so re-reading it tells an attacker nothing they could not already read
 * there, and without the matching private key it still cannot be signed against. What the
 * credential actually gates is *learning which group you are in* — not casting.
 *
 * `redeemedAt` is therefore stamped on the **first** retrieval only, so it stays the timestamp of
 * first collection and the turnout figure (`tokens redeemed / issued`) keeps counting voters
 * rather than page loads.
 */
export async function redeemForRing(presentedToken: string): Promise<RingRetrieval> {
  const presentedHash = hashToken(presentedToken);

  const { token, election } = await db.transaction(async (tx) => {
    const row = await lockTokenByHash(presentedHash, tx);
    // Same error for "no such token" and "expired". Distinguishing them would confirm to an
    // unauthenticated caller that a given token had once been valid.
    if (!row || !hashesMatch(row.tokenHash, presentedHash)) {
      throw new UnauthorizedError("This ballot access link is not valid");
    }
    if (row.expiresAt <= new Date()) {
      throw new UnauthorizedError("This ballot access link is not valid");
    }

    const found = await findElectionById(row.electionId, tx);
    if (!found) throw new UnauthorizedError("This ballot access link is not valid");
    if (found.status !== "VOTING_OPEN") {
      throw new ConflictError("Voting is not open for this election");
    }

    // First retrieval only. Stamped inside the same transaction as the lock, so two simultaneous
    // first-retrievals cannot both claim to be the first.
    if (!row.redeemedAt) {
      await markTokenRedeemed(row.id, tx);
    }
    return { token: row, election: found };
  });

  const ring = await findRingForVoter(token.electionId, token.voterId);
  if (!ring) {
    throw new ConflictError(
      "You have not been placed in an anonymity group for this election",
    );
  }
  if (!ring.publishedAt) {
    throw new ConflictError("Anonymity groups for this election are not published yet");
  }

  const [members, candidateRows] = await Promise.all([
    listRingMembers(ring.id),
    listCandidates(election.id),
  ]);

  return {
    electionId: election.id,
    electionTitle: election.title,
    ringId: ring.id,
    nodeUrl:
      election.chainRootIp && election.chainRootPort !== null
        ? `http://${election.chainRootIp}:${election.chainRootPort}`
        : null,
    publicKeys: members.map((member) => member.publicKey),
    candidates: candidateRows.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      affiliation: candidate.affiliation,
      photoUrl: candidate.photoUrl,
      ballotPosition: candidate.ballotPosition,
    })),
  };
}
