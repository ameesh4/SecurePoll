import type { Request, Response } from "express";
import {
  countAuditEntries,
  listAuditEntries,
} from "../../db/repository/auditLog.repository";
import { parse } from "../middleware/validate";
import { auditQuerySchema, paginationSchema, uuidParamSchema } from "../schemas";

/**
 * The audit record is read-only over HTTP by construction: there is no PATCH or DELETE route
 * here, and the repository exposes no update or delete helper to build one from. An
 * append-only table that the API can edit is not append-only.
 */
export async function listAudit(req: Request, res: Response): Promise<void> {
  const query = parse(auditQuerySchema, req.query);
  const [page, total] = await Promise.all([
    listAuditEntries(query),
    countAuditEntries(),
  ]);

  res.json({
    data: {
      items: page.rows,
      total: page.total,
      totalEntries: total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(page.total / query.pageSize)),
    },
  });
}

/** The same record scoped to one election, for the audit panel on the election screen. */
export async function listElectionAudit(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const { page, pageSize } = parse(paginationSchema, req.query);
  const result = await listAuditEntries({ electionId: id, page, pageSize });

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
