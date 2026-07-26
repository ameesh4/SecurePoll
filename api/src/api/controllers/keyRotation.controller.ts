import type { Request, Response } from "express";
import {
  getPendingRotations,
  requestKeyReplacement,
  reviewKeyReplacement,
} from "../../services/keyRotation.service";
import { currentAdmin } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  keyReplacementSchema,
  keyRotationReviewSchema,
  paginationSchema,
  uuidParamSchema,
} from "../schemas";

/**
 * `POST /api/register/:id/key` — a voter replacing the voting key on their record.
 *
 * Unauthenticated in the session sense: possession of the registration id is what authorises it,
 * the same capability that lets them read their own status page. That is why an *approved* voter's
 * replacement only files a request rather than taking effect — see the service for why.
 */
export async function replaceKey(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { publicKey, reason } = parse(keyReplacementSchema, req.body);
  res.json({
    data: await requestKeyReplacement({
      registrationId: id,
      newPublicKey: publicKey,
      reason,
    }),
  });
}

export async function listKeyRotations(req: Request, res: Response): Promise<void> {
  const { page, pageSize } = parse(paginationSchema, req.query);
  const result = await getPendingRotations({ page, pageSize });

  res.json({
    data: {
      items: result.rows,
      total: result.total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
    },
  });
}

export async function reviewKeyRotation(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { approve, rejectionReason } = parse(keyRotationReviewSchema, req.body);
  const admin = currentAdmin(req);
  const request = await reviewKeyReplacement(id, { approve, rejectionReason }, admin.id);
  res.json({ data: { request } });
}
