import { and, count, desc, eq, gte, ilike, lte } from "drizzle-orm";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import {
  admins,
  auditLog,
  type AuditLogEntry,
  type NewAuditLogEntry,
} from "../schema";

/**
 * Insert and read only. The audit log is append-only, so no update or delete helper is
 * exposed here — adding one would defeat the point of the table.
 */
export async function recordAuditEntry(
  entry: NewAuditLogEntry,
  executor: Executor = db,
): Promise<void> {
  await executor.insert(auditLog).values(entry);
}

/**
 * Appends many entries in one statement.
 *
 * Bulk enrolment writes one row per voter rather than a single summary row, because the audit
 * log's job is to answer "why is this person on the roll" for any given person — a summary
 * saying "340 voters added" cannot answer that. One insert keeps that affordable.
 */
export async function recordAuditEntries(
  entries: readonly NewAuditLogEntry[],
  executor: Executor = db,
): Promise<void> {
  if (entries.length === 0) return;
  await executor.insert(auditLog).values([...entries]);
}

export async function listAuditEntriesForEntity(
  entityType: string,
  entityId: string,
  executor: Executor = db,
): Promise<AuditLogEntry[]> {
  return executor
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)))
    .orderBy(desc(auditLog.createdAt));
}

/**
 * One entry as the audit viewer shows it: the record plus who took the action.
 *
 * The admin's name is resolved by join rather than copied into the row at write time. That
 * is the right trade here — a renamed admin should read correctly in old entries, because
 * the entry's job is to identify *which account* acted, and `adminId` does that immutably.
 */
export interface AuditEntryWithActor {
  entry: AuditLogEntry;
  /** Null when the action was taken by the system rather than a person. */
  actor: { id: string; name: string; email: string; role: string } | null;
}

export interface AuditQuery {
  electionId?: string;
  adminId?: string;
  /** Substring match on the action key, e.g. "ring" to see formation and publication. */
  action?: string;
  entityType?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export async function listAuditEntries(
  query: AuditQuery,
  executor: Executor = db,
): Promise<{ rows: AuditEntryWithActor[]; total: number }> {
  const filters = [];
  if (query.electionId) filters.push(eq(auditLog.electionId, query.electionId));
  if (query.adminId) filters.push(eq(auditLog.adminId, query.adminId));
  if (query.action) filters.push(ilike(auditLog.action, `%${query.action}%`));
  if (query.entityType) filters.push(eq(auditLog.entityType, query.entityType));
  if (query.from) filters.push(gte(auditLog.createdAt, query.from));
  if (query.to) filters.push(lte(auditLog.createdAt, query.to));
  const where = filters.length ? and(...filters) : undefined;

  const [rows, counted] = await Promise.all([
    executor
      .select({
        entry: auditLog,
        actorId: admins.id,
        actorName: admins.name,
        actorEmail: admins.email,
        actorRole: admins.role,
      })
      .from(auditLog)
      .leftJoin(admins, eq(admins.id, auditLog.adminId))
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    executor.select({ value: count() }).from(auditLog).where(where),
  ]);

  return {
    rows: rows.map((row) => ({
      entry: row.entry,
      actor:
        row.actorId && row.actorName && row.actorEmail && row.actorRole
          ? {
              id: row.actorId,
              name: row.actorName,
              email: row.actorEmail,
              role: row.actorRole,
            }
          : null,
    })),
    total: Number(counted[0]?.value ?? 0),
  };
}

export async function countAuditEntries(executor: Executor = db): Promise<number> {
  const rows = await executor.select({ value: count() }).from(auditLog);
  return Number(rows[0]?.value ?? 0);
}
