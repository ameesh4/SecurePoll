import { findAdminByEmail, touchLastLogin } from "../db/repository/admins.repository";
import type { Admin, AdminRole } from "../db/schema";
import { UnauthorizedError } from "../lib/errors";
import { signAdminToken } from "../lib/jwt";
import { fakeVerify, verifyPassword } from "../lib/password";

export interface AdminProfile {
  id: string;
  name: string;
  email: string;
  /**
   * Carried on the profile so the irreversible-action checks can read it from the request.
   *
   * Read from the database on every request via requireAdmin, never from the token. A role
   * baked into a JWT would keep granting freeze-and-publish rights for the rest of the
   * token's life after it had been taken away.
   */
  role: AdminRole;
}

export function toProfile(admin: Admin): AdminProfile {
  return { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
}

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; expiresIn: number; admin: AdminProfile }> {
  const admin = await findAdminByEmail(email);

  // Same error and roughly the same cost for "no such admin", "wrong password" and
  // "deactivated", so none of the three is distinguishable from outside.
  if (!admin || !admin.isActive) {
    await fakeVerify();
    throw new UnauthorizedError("Invalid email or password");
  }

  const ok = await verifyPassword(password, admin.passwordHash);
  if (!ok) throw new UnauthorizedError("Invalid email or password");

  await touchLastLogin(admin.id);

  const { token, expiresIn } = signAdminToken({ sub: admin.id, email: admin.email });
  return { token, expiresIn, admin: toProfile(admin) };
}
