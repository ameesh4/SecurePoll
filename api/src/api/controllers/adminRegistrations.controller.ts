import type { Request, Response } from "express";
import {
  approveRegistration,
  approveRegistrations,
  getQueue,
  getRegistrationDetail,
  rejectRegistration,
  rejectRegistrations,
} from "../../services/review.service";
import { currentAdmin } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  approvalSchema,
  bulkApprovalSchema,
  bulkRejectionSchema,
  registrationQuerySchema,
  rejectionSchema,
  uuidParamSchema,
} from "../schemas";

export async function listRegistrations(
  req: Request,
  res: Response,
): Promise<void> {
  const query = parse(registrationQuerySchema, req.query);
  res.json({ data: await getQueue(query) });
}

export async function getRegistration(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  res.json({ data: await getRegistrationDetail(id) });
}

export async function approveRegistrationById(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { electionId } = parse(approvalSchema, req.body ?? {});
  const admin = currentAdmin(req);
  const result = await approveRegistration(id, admin.id, { electionId });
  res.json({ data: result });
}

export async function rejectRegistrationById(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { reason } = parse(rejectionSchema, req.body);
  const admin = currentAdmin(req);
  const registration = await rejectRegistration(id, admin.id, reason);
  res.json({ data: { registration } });
}

/**
 * Bulk approve. Returns per-registration outcomes rather than one success flag, because some
 * of them can legitimately fail — a duplicate discovered under the lock, or a record another
 * admin actioned a moment earlier — and the queue has to show which ones did not land rather
 * than reporting a clean sweep.
 */
export async function approveRegistrationsBulk(
  req: Request,
  res: Response,
): Promise<void> {
  const { registrationIds, electionId } = parse(bulkApprovalSchema, req.body);
  const admin = currentAdmin(req);
  const outcome = await approveRegistrations(registrationIds, admin.id, { electionId });
  res.json({ data: outcome });
}

export async function rejectRegistrationsBulk(
  req: Request,
  res: Response,
): Promise<void> {
  const { registrationIds, reason } = parse(bulkRejectionSchema, req.body);
  const admin = currentAdmin(req);
  const outcome = await rejectRegistrations(registrationIds, admin.id, reason);
  res.json({ data: outcome });
}
