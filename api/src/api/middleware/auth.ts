import type { NextFunction, Request, Response } from "express";
import { findAdminById } from "../../db/repository/admins.repository";
import { ForbiddenError, UnauthorizedError } from "../../lib/errors";
import { verifyAdminToken } from "../../lib/jwt";
import { toProfile, type AdminProfile } from "../../services/adminAuth.service";

/**
 * Verifies the bearer token and then re-loads the admin.
 *
 * The database round-trip is deliberate. Sessions are stateless JWTs with no server-side
 * revocation, so without this check a deleted or deactivated admin would keep full approval
 * rights until their token happened to expire.
 */
export async function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    next(new UnauthorizedError("Authentication required"));
    return;
  }

  try {
    const claims = verifyAdminToken(header.slice("Bearer ".length).trim());
    const admin = await findAdminById(claims.sub);
    if (!admin || !admin.isActive) {
      next(new UnauthorizedError("Session is no longer valid"));
      return;
    }
    req.admin = toProfile(admin);
    next();
  } catch (error) {
    next(error);
  }
}

/** Narrows `req.admin` for handlers mounted behind requireAdmin. */
export function currentAdmin(req: Request): AdminProfile {
  if (!req.admin) throw new UnauthorizedError();
  return req.admin;
}

/**
 * Gates a route on the super-admin role.
 *
 * Belt and braces: the services that matter check the role themselves, next to the operation they
 * protect, which is where the rule is meaningful and where it cannot be bypassed by a new route
 * forgetting this middleware. This exists so an entire router can be closed off in one line, and so
 * the refusal happens before any handler work.
 *
 * The role comes from the freshly-loaded admin row rather than the token, so revoking it takes
 * effect on the next request instead of when the JWT happens to expire.
 */
export function requireSuperAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const admin = req.admin;
  if (!admin) {
    next(new UnauthorizedError("Authentication required"));
    return;
  }
  if (admin.role !== "SUPER_ADMIN") {
    next(new ForbiddenError("This area is restricted to super-admins"));
    return;
  }
  next();
}
