import type { Request, Response } from "express";
import {
  changeRecipient,
  dispatchPending,
  getDispatchView,
  issueTokens,
  redeemForRing,
  resendToken,
  retryFailed,
} from "../../services/ballotAccess.service";
import { currentAdmin } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  recipientChangeSchema,
  ringRetrievalSchema,
  tokenQuerySchema,
  uuidParamSchema,
} from "../schemas";

export async function listBallotAccess(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const query = parse(tokenQuerySchema, req.query);
  const { rows, ...view } = await getDispatchView({ electionId: id, ...query });

  res.json({
    data: {
      ...view,
      totalPages: Math.max(1, Math.ceil(view.total / view.pageSize)),
      // Delivery state and whether access was collected, and nothing else. There is no field
      // here for what was voted, because this server holds no such fact to expose. "Access
      // used" is the same thing a paper roll book records when a voter signs in.
      items: rows.map((row) => ({
        id: row.token.id,
        voterId: row.voter.id,
        fullName: row.voter.fullName,
        deliverTo: row.token.deliverTo,
        emailStatus: row.token.emailStatus,
        deliveryAttempts: row.token.deliveryAttempts,
        lastAttemptAt: row.token.lastAttemptAt,
        lastError: row.token.lastError,
        accessUsed: row.token.redeemedAt !== null,
        redeemedAt: row.token.redeemedAt,
        expiresAt: row.token.expiresAt,
      })),
    },
  });
}

export async function issueBallotAccess(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const admin = currentAdmin(req);
  res.json({ data: await issueTokens(id, admin) });
}

export async function dispatchBallotAccess(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  res.json({ data: await dispatchPending(id) });
}

export async function retryBallotAccess(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const admin = currentAdmin(req);
  res.json({ data: await retryFailed(id, admin.id) });
}

export async function resendBallotAccess(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const admin = currentAdmin(req);
  res.json({ data: await resendToken(id, admin.id) });
}

export async function changeBallotRecipient(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { email } = parse(recipientChangeSchema, req.body);
  const admin = currentAdmin(req);
  const token = await changeRecipient(id, email, admin.id);
  res.json({ data: { id: token.id, deliverTo: token.deliverTo, emailStatus: token.emailStatus } });
}

/**
 * `POST /api/ring` — public, and the only thing a ballot-access credential authorises.
 *
 * Unauthenticated in the session sense: the credential in the body *is* the authentication,
 * and it is spent here. What comes back is the caller's ring, without their index in it.
 */
export async function retrieveRing(req: Request, res: Response): Promise<void> {
  const { token } = parse(ringRetrievalSchema, req.body);
  res.json({ data: await redeemForRing(token) });
}
