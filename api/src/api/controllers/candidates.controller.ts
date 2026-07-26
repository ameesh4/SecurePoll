import type { Request, Response } from "express";
import {
  addCandidate,
  editCandidate,
  getCandidatesByOffice,
  removeCandidate,
  reorderOffice,
} from "../../services/candidate.service";
import { currentAdmin } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  candidateCreateSchema,
  candidateReorderSchema,
  candidateUpdateSchema,
  uuidParamSchema,
} from "../schemas";

export async function listCandidatesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  res.json({ data: { offices: await getCandidatesByOffice(id) } });
}

export async function createCandidateHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const input = parse(candidateCreateSchema, req.body);
  const admin = currentAdmin(req);
  const candidate = await addCandidate(id, input, admin.id);
  res.status(201).json({ data: { candidate } });
}

export async function updateCandidateHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const input = parse(candidateUpdateSchema, req.body);
  const admin = currentAdmin(req);
  const candidate = await editCandidate(id, input, admin.id);
  res.json({ data: { candidate } });
}

export async function deleteCandidateHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const admin = currentAdmin(req);
  await removeCandidate(id, admin.id);
  res.json({ data: { ok: true } });
}

export async function reorderCandidatesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { office, candidateIds } = parse(candidateReorderSchema, req.body);
  const admin = currentAdmin(req);
  const candidates = await reorderOffice(id, office, candidateIds, admin.id);
  res.json({ data: { candidates } });
}
