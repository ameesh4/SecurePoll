import { randomBytes } from "crypto";
import { db } from "../db/drizzle";
import { recordAuditEntry } from "../db/repository/auditLog.repository";
import {
  countActiveSuperAdmins,
  createAdmin,
  findAdminByEmail,
  findAdminById,
  listAdmins,
  lockAdminById,
  setAdminActive,
  updateAdminPassword,
  updateAdminRole,
} from "../db/repository/admins.repository";
import { AuditAction, type Admin, type AdminRole } from "../db/schema";
import { asConflictError } from "../lib/conflicts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../lib/errors";
import { hashPassword, verifyPassword } from "../lib/password";

/**
 * Managing operator accounts.
 *
 * This is a deliberate change of posture, and worth naming as such: the seed script's comment says
 * admins are created out of band precisely because the ability to approve a registration is the
 * ability to add a voter to an election. That reasoning is sound, but it argues for the operation
 * being *restricted and recorded*, not for it requiring shell access — an election office that must
 * call a developer to onboard a reviewer will end up sharing one login instead, which is strictly
 * worse for the audit trail this system is built around.
 *
 * So account creation moves into the product with three conditions: super-admin only, every change
 * audited against the actor, and the estate protected from being locked out of itself.
 */

/** Fields safe to return. `passwordHash` must never leave this layer. */
export interface AdminView {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export function toAdminView(admin: Admin): AdminView {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    isActive: admin.isActive,
    lastLoginAt: admin.lastLoginAt,
    createdAt: admin.createdAt,
  };
}

export async function listAdministrators(): Promise<AdminView[]> {
  return (await listAdmins()).map(toAdminView);
}

/**
 * A strong initial password, generated here rather than chosen by the creator.
 *
 * Letting a super-admin pick somebody else's password invites a weak, reused, or spoken-aloud one,
 * and guarantees the creator knows a working credential for another operator indefinitely. Minting
 * it means the value is random, shown exactly once, and immediately changeable by its owner.
 */
function mintInitialPassword(): string {
  return randomBytes(18).toString("base64url");
}

export interface CreatedAdmin {
  admin: AdminView;
  /**
   * The initial password, returned exactly once and never stored in plaintext.
   *
   * The API hands this back on the create response only; there is no endpoint that can read it
   * again, because only its bcrypt hash was kept.
   */
  initialPassword: string;
}

export async function createAdministrator(
  input: { name: string; email: string; role: AdminRole },
  actor: { id: string; role: string },
): Promise<CreatedAdmin> {
  assertSuperAdminActor(actor, "Creating an operator account");

  const email = input.email.trim().toLowerCase();
  if (await findAdminByEmail(email)) {
    throw new ConflictError("An operator with that email already exists");
  }

  const initialPassword = mintInitialPassword();
  const passwordHash = await hashPassword(initialPassword);

  const created = await db.transaction(async (tx) => {
    let admin: Admin;
    try {
      admin = await createAdmin(
        { name: input.name.trim(), email, role: input.role, passwordHash },
        tx,
      );
    } catch (error) {
      // The unique index on email decides a race between two creators.
      const conflict = asConflictError(
        error,
        "An operator with that email already exists",
      );
      if (conflict) throw conflict;
      throw error;
    }

    await recordAuditEntry(
      {
        adminId: actor.id,
        action: AuditAction.AdminCreated,
        entityType: "admin",
        entityId: admin.id,
        before: null,
        // Deliberately records who and what role — never the password or its hash.
        after: { name: admin.name, email: admin.email, role: admin.role },
      },
      tx,
    );

    return admin;
  });

  return { admin: toAdminView(created), initialPassword };
}

function assertSuperAdminActor(actor: { role: string }, action: string): void {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ForbiddenError(`${action} requires a super-admin`);
  }
}

/**
 * Refuses changes that would leave nobody able to run the system.
 *
 * Two separate protections, and they catch different mistakes. Acting on your own account is
 * refused outright — self-demotion is the easiest way to lock yourself out, and self-promotion
 * would make the role meaningless. Removing the *last* active super-admin is refused because the
 * result is an estate where no election can be advanced and no operator can be created, with no
 * in-product way back.
 */
async function assertEstateSurvives(
  target: Admin,
  next: { role?: AdminRole; isActive?: boolean },
  executor: Parameters<typeof countActiveSuperAdmins>[0],
): Promise<void> {
  const wasCountedSuperAdmin = target.role === "SUPER_ADMIN" && target.isActive;
  if (!wasCountedSuperAdmin) return;

  const stillSuperAdmin = (next.role ?? target.role) === "SUPER_ADMIN";
  const stillActive = next.isActive ?? target.isActive;
  if (stillSuperAdmin && stillActive) return;

  const remaining = await countActiveSuperAdmins(executor);
  if (remaining <= 1) {
    throw new ConflictError(
      "This is the last active super-admin. Promote another operator first — without one, no " +
        "election can be advanced and no account can be created.",
    );
  }
}

export async function changeAdminRole(
  targetId: string,
  role: AdminRole,
  actor: { id: string; role: string },
): Promise<AdminView> {
  assertSuperAdminActor(actor, "Changing an operator's role");
  if (targetId === actor.id) {
    throw new ForbiddenError(
      "You cannot change your own role. Ask another super-admin to do it.",
    );
  }

  return db.transaction(async (tx) => {
    const target = await lockAdminById(targetId, tx);
    if (!target) throw new NotFoundError("Operator not found");
    if (target.role === role) {
      throw new ConflictError(`That operator is already a ${label(role)}`);
    }

    await assertEstateSurvives(target, { role }, tx);
    const updated = await updateAdminRole(targetId, role, tx);

    await recordAuditEntry(
      {
        adminId: actor.id,
        action: AuditAction.AdminRoleChanged,
        entityType: "admin",
        entityId: targetId,
        before: { role: target.role },
        after: { role: updated.role },
      },
      tx,
    );

    return toAdminView(updated);
  });
}

export async function setAdministratorActive(
  targetId: string,
  isActive: boolean,
  actor: { id: string; role: string },
): Promise<AdminView> {
  assertSuperAdminActor(actor, "Changing an operator's access");
  if (targetId === actor.id) {
    throw new ForbiddenError("You cannot deactivate your own account.");
  }

  return db.transaction(async (tx) => {
    const target = await lockAdminById(targetId, tx);
    if (!target) throw new NotFoundError("Operator not found");
    if (target.isActive === isActive) {
      throw new ConflictError(
        `That operator is already ${isActive ? "active" : "deactivated"}`,
      );
    }

    await assertEstateSurvives(target, { isActive }, tx);
    const updated = await setAdminActive(targetId, isActive, tx);

    await recordAuditEntry(
      {
        adminId: actor.id,
        action: isActive ? AuditAction.AdminReactivated : AuditAction.AdminDeactivated,
        entityType: "admin",
        entityId: targetId,
        before: { isActive: target.isActive },
        after: { isActive: updated.isActive },
      },
      tx,
    );

    return toAdminView(updated);
  });
}

function label(role: AdminRole): string {
  return role === "SUPER_ADMIN" ? "super-admin" : "reviewer";
}

const MIN_PASSWORD_LENGTH = 12;

/**
 * An operator changing their own password.
 *
 * Requires the current one, so a stolen session cannot silently take permanent ownership of the
 * account. This is also what makes the generated initial password acceptable: whoever created the
 * account knows that value until its owner replaces it, so its owner needs a way to replace it
 * without going through them.
 *
 * Sessions are stateless JWTs with no server-side revocation, so a token issued before the change
 * keeps working until it expires. Cutting one off early still means clearing `is_active`.
 */
export async function changeOwnPassword(
  adminId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestError(
      `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`,
      { fieldErrors: { newPassword: [`At least ${MIN_PASSWORD_LENGTH} characters`] } },
    );
  }
  if (newPassword === currentPassword) {
    throw new BadRequestError("Choose a password you have not used here before", {
      fieldErrors: { newPassword: ["Must differ from your current password"] },
    });
  }

  const admin = await findAdminById(adminId);
  if (!admin) throw new NotFoundError("Operator not found");

  const ok = await verifyPassword(currentPassword, admin.passwordHash);
  if (!ok) throw new UnauthorizedError("Your current password is not correct");

  await db.transaction(async (tx) => {
    await updateAdminPassword(adminId, await hashPassword(newPassword), tx);
    await recordAuditEntry(
      {
        adminId,
        action: AuditAction.AdminPasswordChanged,
        entityType: "admin",
        entityId: adminId,
        before: null,
        // Records that it happened and when. Nothing about the value, in either direction.
        after: { changed: true },
      },
      tx,
    );
  });
}
