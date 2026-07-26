import type { Request, Response } from "express";
import {
  changeAdminRole,
  changeOwnPassword,
  createAdministrator,
  listAdministrators,
  setAdministratorActive,
} from "../../services/adminManagement.service";
import { currentAdmin } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  adminCreateSchema,
  adminUpdateSchema,
  passwordChangeSchema,
  uuidParamSchema,
} from "../schemas";

export async function listAdminsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ data: { items: await listAdministrators() } });
}

/**
 * Creates an operator and returns the generated initial password.
 *
 * This is the only response that will ever contain it — only the bcrypt hash is stored, so there is
 * no endpoint that could show it again. The interface has to display it once and say so.
 */
export async function createAdminHandler(req: Request, res: Response): Promise<void> {
  const input = parse(adminCreateSchema, req.body);
  const actor = currentAdmin(req);
  res.status(201).json({ data: await createAdministrator(input, actor) });
}

export async function updateAdminHandler(req: Request, res: Response): Promise<void> {
  const { id } = parse(uuidParamSchema, req.params);
  const changes = parse(adminUpdateSchema, req.body);
  const actor = currentAdmin(req);

  // Applied one at a time so each change is refused, and audited, on its own terms.
  let admin = undefined;
  if (changes.role !== undefined) {
    admin = await changeAdminRole(id, changes.role, actor);
  }
  if (changes.isActive !== undefined) {
    admin = await setAdministratorActive(id, changes.isActive, actor);
  }

  res.json({ data: { admin } });
}

/** An operator changing their own password. Not restricted by role — it only affects themselves. */
export async function changePasswordHandler(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = parse(passwordChangeSchema, req.body);
  const admin = currentAdmin(req);
  await changeOwnPassword(admin.id, currentPassword, newPassword);
  res.json({ data: { ok: true } });
}
