import type { Request, Response } from "express";
import { login } from "../../services/adminAuth.service";
import { currentAdmin } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { adminLoginSchema } from "../schemas";

export async function loginAdmin(req: Request, res: Response): Promise<void> {
  const credentials = parse(adminLoginSchema, req.body);
  const result = await login(credentials.email, credentials.password);
  res.json({ data: result });
}

/**
 * Sessions are stateless JWTs, so there is nothing server-side to tear down: the client
 * discards the token and it simply stops being presented. The endpoint exists so the
 * frontend has one thing to call, and so this limitation is written down somewhere.
 *
 * To actually cut off an admin before their token expires, clear `admins.is_active` — that
 * is checked on every authenticated request.
 */
export function logoutAdmin(_req: Request, res: Response): void {
  res.json({ data: { ok: true } });
}

export function getCurrentAdmin(req: Request, res: Response): void {
  res.json({ data: currentAdmin(req) });
}
