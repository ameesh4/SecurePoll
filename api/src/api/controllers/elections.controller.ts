import type { Request, Response } from "express";
import {
  listElectorate,
  listVotersNotOnRoll,
} from "../../db/repository/eligibility.repository";
import { getDashboard } from "../../services/dashboard.service";
import {
  createNewElection,
  getElectionDetail,
  getMonitoringSnapshot,
  listElectionSummaries,
  previewTransition,
  transitionElection,
  updateElectionMetadata,
} from "../../services/election.service";
import { LIFECYCLE_STAGES, STATUS_LABELS } from "../../services/lifecycle";
import {
  removeVotersFromRoll,
  setEligibility,
  transferVotersOntoRoll,
} from "../../services/review.service";
import { currentAdmin } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  bulkEligibilitySchema,
  electionCreateSchema,
  electionTransitionSchema,
  electionUpdateSchema,
  eligibilitySchema,
  uuidParamSchema,
  voterQuerySchema,
} from "../schemas";

export async function dashboard(_req: Request, res: Response): Promise<void> {
  res.json({
    data: {
      ...(await getDashboard()),
      // The rail and its labels are served rather than duplicated in the client, so the two
      // cannot disagree about what the stages are or what they are called.
      stages: LIFECYCLE_STAGES.map((status) => ({
        status,
        label: STATUS_LABELS[status],
      })),
    },
  });
}

export async function listAllElections(_req: Request, res: Response): Promise<void> {
  res.json({ data: { items: await listElectionSummaries() } });
}

export async function getElection(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  res.json({ data: await getElectionDetail(id) });
}

export async function createElectionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const input = parse(electionCreateSchema, req.body);
  const admin = currentAdmin(req);
  const election = await createNewElection(input, admin.id);
  res.status(201).json({ data: { election } });
}

export async function updateElectionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const input = parse(electionUpdateSchema, req.body);
  const admin = currentAdmin(req);
  const election = await updateElectionMetadata(id, input, admin.id);
  res.json({ data: { election } });
}

/**
 * Read-only pre-flight, so the confirmation dialog can show the admin what will be checked
 * before they type the phrase. The transition itself re-runs these under a row lock — this is
 * a courtesy, not the enforcement.
 */
export async function previewTransitionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { to } = parse(electionTransitionSchema, req.query);
  res.json({ data: await previewTransition(id, to) });
}

export async function transitionElectionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { to } = parse(electionTransitionSchema, req.body);
  const admin = currentAdmin(req);
  const election = await transitionElection(id, to, admin);
  res.json({ data: { election } });
}

export async function monitoring(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  res.json({ data: await getMonitoringSnapshot(id) });
}

export async function listVoters(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const query = parse(voterQuerySchema, req.query);
  const page = await listElectorate({ electionId: id, ...query });

  res.json({
    data: {
      items: page.rows,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(page.total / query.pageSize)),
    },
  });
}

export async function updateEligibility(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { voterId, eligible } = parse(eligibilitySchema, req.body);
  const admin = currentAdmin(req);
  await setEligibility(id, voterId, eligible, admin.id);
  res.json({ data: { ok: true } });
}

/**
 * Vetted voters who are not yet on this election's roll — the pool for bulk transfer.
 *
 * Everyone listed here has already been through the review queue and had a voter record minted,
 * so enrolling them is a second, per-election decision rather than a fresh identity check.
 */
export async function listAvailableVoters(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const query = parse(voterQuerySchema, req.query);
  const page = await listVotersNotOnRoll({ electionId: id, ...query });

  res.json({
    data: {
      items: page.rows,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(page.total / query.pageSize)),
    },
  });
}

/**
 * Adds or removes many voters from the roll in one request.
 *
 * Reports per-voter outcomes rather than a bare success: some of the selection may already be
 * enrolled, and on removal some may be locked into a published ring and legitimately refused.
 */
export async function updateEligibilityBulk(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { voterIds, eligible } = parse(bulkEligibilitySchema, req.body);
  const admin = currentAdmin(req);

  if (eligible) {
    res.json({ data: await transferVotersOntoRoll(id, voterIds, admin.id) });
    return;
  }
  res.json({ data: await removeVotersFromRoll(id, voterIds, admin.id) });
}
