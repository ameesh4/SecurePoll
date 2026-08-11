import type { Request, Response } from "express";
import {
  exportChainManifest,
  formRings,
  listRingDetails,
  previewFormation,
  previewPublish,
  publishRings,
} from "../../services/ring.service";
import { currentAdmin } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { paginationSchema, uuidParamSchema } from "../schemas";

/**
 * What forming groups would produce, or — once groups exist — what is actually on the table
 * awaiting freeze. Writes nothing.
 */
export async function previewRings(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  res.json({ data: await previewFormation(id) });
}

export async function formRingsHandler(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const admin = currentAdmin(req);
  res.json({ data: await formRings(id, admin.id) });
}

export async function listRingsHandler(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { page, pageSize } = parse(paginationSchema, req.query);
  const result = await listRingDetails(id, page, pageSize);

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

/** Pre-flight for the freeze-and-publish dialog. */
export async function previewPublishHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  res.json({ data: await previewPublish(id) });
}

/**
 * Freezes membership by publishing every group to the ledger. Irreversible, and gated on
 * SUPER_ADMIN inside the service rather than here — the rule belongs next to the operation it
 * protects, not in the transport layer.
 */
export async function publishRingsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const admin = currentAdmin(req);
  res.json({ data: await publishRings(id, admin) });
}

/**
 * The election manifest a ledger node imports from disk (blockchain/ELECTION_MANIFEST.md).
 *
 * Served as a file download rather than a JSON envelope: the bytes are the artifact, and the
 * digest recorded against each ring is computed over exactly these bytes. Wrapping them in the
 * usual `{ data }` envelope would mean the thing the operator saves is not the thing the digest
 * describes.
 */
export async function exportChainManifestHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const admin = currentAdmin(req);
  const { serialized, digest } = await exportChainManifest(id, admin);

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="election-${id}.json"`);
  res.setHeader("X-Manifest-Digest", digest);
  res.send(serialized);
}
