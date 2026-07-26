import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../drizzle";
import type { Executor } from "../executor";
import { admins, type Admin, type AdminRole, type NewAdmin } from "../schema";

export async function findAdminByEmail(
  email: string,
  executor: Executor = db,
): Promise<Admin | undefined> {
  const rows = await executor
    .select()
    .from(admins)
    .where(eq(admins.email, email.trim().toLowerCase()))
    .limit(1);
  return rows[0];
}

export async function findAdminById(
  id: string,
  executor: Executor = db,
): Promise<Admin | undefined> {
  const rows = await executor.select().from(admins).where(eq(admins.id, id)).limit(1);
  return rows[0];
}

export async function createAdmin(values: NewAdmin, executor: Executor = db): Promise<Admin> {
  const rows = await executor
    .insert(admins)
    .values({ ...values, email: values.email.trim().toLowerCase() })
    .returning();
  const created = rows[0];
  if (!created) throw new Error("Failed to create admin");
  return created;
}

export async function touchLastLogin(id: string, executor: Executor = db): Promise<void> {
  await executor
    .update(admins)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(admins.id, id));
}

/** Every operator account, newest first. Never returns password hashes to callers by convention. */
export async function listAdmins(executor: Executor = db): Promise<Admin[]> {
  return executor.select().from(admins).orderBy(desc(admins.createdAt));
}

export async function updateAdminRole(
  id: string,
  role: AdminRole,
  executor: Executor,
): Promise<Admin> {
  const rows = await executor
    .update(admins)
    .set({ role, updatedAt: new Date() })
    .where(eq(admins.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) throw new Error("Failed to update admin role");
  return updated;
}

export async function setAdminActive(
  id: string,
  isActive: boolean,
  executor: Executor,
): Promise<Admin> {
  const rows = await executor
    .update(admins)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(admins.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) throw new Error("Failed to update admin status");
  return updated;
}

export async function updateAdminPassword(
  id: string,
  passwordHash: string,
  executor: Executor,
): Promise<void> {
  await executor
    .update(admins)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(admins.id, id));
}

/**
 * Active super-admins, counted so the last one cannot be demoted or switched off.
 *
 * Without this the system has a trapdoor: freezing groups, opening voting and creating operators
 * all require a super-admin, so an estate with none is one nobody can run — and there is no
 * self-service recovery, only shell access to the database.
 */
export async function countActiveSuperAdmins(executor: Executor = db): Promise<number> {
  const rows = await executor
    .select({ value: count() })
    .from(admins)
    .where(and(eq(admins.role, "SUPER_ADMIN"), eq(admins.isActive, true)));
  return Number(rows[0]?.value ?? 0);
}

/** Locks the row so two concurrent role changes cannot both pass the last-super-admin check. */
export async function lockAdminById(
  id: string,
  executor: Executor,
): Promise<Admin | undefined> {
  const rows = await executor
    .select()
    .from(admins)
    .where(eq(admins.id, id))
    .limit(1)
    .for("update");
  return rows[0];
}
