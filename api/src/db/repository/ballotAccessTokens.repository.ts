import { and, asc, count, eq, ilike, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import {
  ballotAccessTokens,
  voters,
  type BallotAccessToken,
  type EmailDeliveryStatus,
  type NewBallotAccessToken,
  type Voter,
} from "../schema";

export async function insertTokens(
  values: readonly NewBallotAccessToken[],
  executor: Executor,
): Promise<BallotAccessToken[]> {
  if (values.length === 0) return [];
  // Voters who already hold a credential are skipped rather than re-issued: minting a second
  // token for someone would leave two valid credentials for one ballot.
  return executor
    .insert(ballotAccessTokens)
    .values([...values])
    .onConflictDoNothing()
    .returning();
}

export async function findTokenById(
  id: string,
  executor: Executor = db,
): Promise<BallotAccessToken | undefined> {
  const rows = await executor
    .select()
    .from(ballotAccessTokens)
    .where(eq(ballotAccessTokens.id, id))
    .limit(1);
  return rows[0];
}

/**
 * Looks a credential up by the hash of the presented token, locking the row.
 *
 * The lock is what makes single use real. Two concurrent redemptions of the same token would
 * otherwise both read `redeemedAt` as null and both succeed, and the whole purpose of the
 * credential is that it works once.
 */
export async function lockTokenByHash(
  tokenHash: string,
  executor: Executor,
): Promise<BallotAccessToken | undefined> {
  const rows = await executor
    .select()
    .from(ballotAccessTokens)
    .where(eq(ballotAccessTokens.tokenHash, tokenHash))
    .limit(1)
    .for("update");
  return rows[0];
}

/**
 * Replaces the stored hash with a freshly minted one.
 *
 * Every send rotates the credential, because only the hash is kept — the plaintext lives in
 * one outbound email and nowhere else, so a re-send cannot repeat the old token and has to
 * supersede it. A link from a previous attempt stops working the moment this runs, which is
 * what makes correcting a wrong address a revocation rather than an addition.
 */
export async function rotateTokenHash(
  id: string,
  tokenHash: string,
  executor: Executor = db,
): Promise<void> {
  await executor
    .update(ballotAccessTokens)
    .set({ tokenHash, updatedAt: new Date() })
    .where(eq(ballotAccessTokens.id, id));
}

export async function markTokenRedeemed(
  id: string,
  executor: Executor,
): Promise<BallotAccessToken> {
  const rows = await executor
    .update(ballotAccessTokens)
    .set({ redeemedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(ballotAccessTokens.id, id), isNull(ballotAccessTokens.redeemedAt)))
    .returning();

  const updated = rows[0];
  if (!updated) throw new Error("Token was already redeemed");
  return updated;
}

export async function recordDeliveryAttempt(
  id: string,
  outcome: { status: EmailDeliveryStatus; error?: string | null },
  executor: Executor = db,
): Promise<void> {
  await executor
    .update(ballotAccessTokens)
    .set({
      emailStatus: outcome.status,
      lastAttemptAt: new Date(),
      lastError: outcome.error ?? null,
      deliveryAttempts: sql`${ballotAccessTokens.deliveryAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(ballotAccessTokens.id, id));
}

export async function updateRecipient(
  id: string,
  deliverTo: string,
  executor: Executor = db,
): Promise<BallotAccessToken> {
  const rows = await executor
    .update(ballotAccessTokens)
    .set({
      deliverTo,
      // A corrected address starts the recipient's delivery over rather than inheriting the
      // BOUNCED state of the address that was wrong.
      emailStatus: "PENDING",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(ballotAccessTokens.id, id))
    .returning();

  const updated = rows[0];
  if (!updated) throw new Error("Failed to update token recipient");
  return updated;
}

/** Credentials still waiting to go out, oldest first. Drives the dispatch worker. */
export async function claimPendingTokens(
  electionId: string,
  limit: number,
  executor: Executor = db,
): Promise<BallotAccessToken[]> {
  return executor
    .select()
    .from(ballotAccessTokens)
    .where(
      and(
        eq(ballotAccessTokens.electionId, electionId),
        eq(ballotAccessTokens.emailStatus, "PENDING"),
      ),
    )
    .orderBy(asc(ballotAccessTokens.issuedAt))
    .limit(limit);
}

export interface TokenRow {
  token: BallotAccessToken;
  voter: Voter;
}

export interface TokenListQuery {
  electionId: string;
  status?: EmailDeliveryStatus;
  search?: string;
  page: number;
  pageSize: number;
}

export async function listTokens(
  query: TokenListQuery,
  executor: Executor = db,
): Promise<{ rows: TokenRow[]; total: number }> {
  const filters = [eq(ballotAccessTokens.electionId, query.electionId)];
  if (query.status) filters.push(eq(ballotAccessTokens.emailStatus, query.status));
  if (query.search) {
    const term = `%${query.search}%`;
    const matches = or(
      ilike(voters.fullName, term),
      ilike(ballotAccessTokens.deliverTo, term),
    );
    if (matches) filters.push(matches);
  }
  const where = and(...filters);

  const [rows, counted] = await Promise.all([
    executor
      .select({ token: ballotAccessTokens, voter: voters })
      .from(ballotAccessTokens)
      .innerJoin(voters, eq(voters.id, ballotAccessTokens.voterId))
      .where(where)
      .orderBy(asc(voters.fullName))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    executor
      .select({ value: count() })
      .from(ballotAccessTokens)
      .innerJoin(voters, eq(voters.id, ballotAccessTokens.voterId))
      .where(where),
  ]);

  return {
    rows: rows.map((row) => ({ token: row.token, voter: row.voter })),
    total: Number(counted[0]?.value ?? 0),
  };
}

export interface DispatchSummary {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  bounced: number;
  redeemed: number;
}

export async function summariseDispatch(
  electionId: string,
  executor: Executor = db,
): Promise<DispatchSummary> {
  const rows = await executor
    .select({
      status: ballotAccessTokens.emailStatus,
      value: sql<number>`count(*)::int`,
      redeemed: sql<number>`count(${ballotAccessTokens.redeemedAt})::int`,
    })
    .from(ballotAccessTokens)
    .where(eq(ballotAccessTokens.electionId, electionId))
    .groupBy(ballotAccessTokens.emailStatus);

  const summary: DispatchSummary = {
    total: 0,
    pending: 0,
    sent: 0,
    failed: 0,
    bounced: 0,
    redeemed: 0,
  };

  for (const row of rows) {
    summary.total += row.value;
    summary.redeemed += row.redeemed;
    if (row.status === "PENDING") summary.pending = row.value;
    if (row.status === "SENT") summary.sent = row.value;
    if (row.status === "FAILED") summary.failed = row.value;
    if (row.status === "BOUNCED") summary.bounced = row.value;
  }

  return summary;
}

/**
 * Consumes one unit of a credential's resend allowance, returning false when the current
 * window is already spent.
 *
 * Written as a single conditional UPDATE rather than read-then-write so that concurrent
 * resend clicks cannot both observe the same remaining allowance and both proceed. The
 * `where` does the arithmetic: it matches only when the window has rolled over (so the
 * counter resets) or when the count is still under the cap.
 *
 * Returns the row it updated so the caller has the address to deliver to.
 */
export async function consumeResendAllowance(
  id: string,
  limits: { max: number; windowMs: number },
  executor: Executor = db,
): Promise<BallotAccessToken | null> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - limits.windowMs);

  const rows = await executor
    .update(ballotAccessTokens)
    .set({
      resendWindowStartedAt: sql`
        case
          when ${ballotAccessTokens.resendWindowStartedAt} is null
            or ${ballotAccessTokens.resendWindowStartedAt} <= ${windowStart}
          then ${now}
          else ${ballotAccessTokens.resendWindowStartedAt}
        end`,
      resendsInWindow: sql`
        case
          when ${ballotAccessTokens.resendWindowStartedAt} is null
            or ${ballotAccessTokens.resendWindowStartedAt} <= ${windowStart}
          then 1
          else ${ballotAccessTokens.resendsInWindow} + 1
        end`,
      updatedAt: now,
    })
    .where(
      and(
        eq(ballotAccessTokens.id, id),
        or(
          isNull(ballotAccessTokens.resendWindowStartedAt),
          lte(ballotAccessTokens.resendWindowStartedAt, windowStart),
          lt(ballotAccessTokens.resendsInWindow, limits.max),
        ),
      ),
    )
    .returning();

  return rows[0] ?? null;
}
