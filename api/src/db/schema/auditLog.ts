import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { admins } from "./admins";
import { elections } from "./elections";

/**
 * Append-only record of every admin action that changes eligibility, ring membership, or
 * election state. Nothing in the application layer may update or delete a row here; the
 * repository exposes insert and read only.
 *
 * `action` is free text rather than an enum so that adding a new auditable operation never
 * requires a schema change. The known values live in `AuditAction`.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for actions taken by the system rather than a person. */
    adminId: uuid("admin_id").references(() => admins.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    /**
     * Denormalised scope. `entityId` already identifies the thing that changed, but that is
     * a candidate or a ring or a registration depending on the action, so "everything that
     * happened to this election" is not answerable from it. Auditors ask exactly that
     * question, and the audit viewer filters on it.
     */
    electionId: uuid("election_id").references(() => elections.id, {
      onDelete: "restrict",
    }),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_created_idx").on(t.createdAt),
    index("audit_log_admin_idx").on(t.adminId),
    // The audit viewer reads one election newest-first.
    index("audit_log_election_created_idx").on(t.electionId, t.createdAt),
  ],
);

export const AuditAction = {
  RegistrationApproved: "registration.approved",
  RegistrationRejected: "registration.rejected",
  AdminLoggedIn: "admin.logged_in",

  ElectionCreated: "election.created",
  ElectionUpdated: "election.updated",
  ElectionTransitioned: "election.transitioned",

  CandidateAdded: "candidate.added",
  CandidateUpdated: "candidate.updated",
  CandidateRemoved: "candidate.removed",

  EligibilityGranted: "eligibility.granted",
  EligibilityRevoked: "eligibility.revoked",

  RingsFormed: "rings.formed",
  RingsPublished: "rings.published",

  TokensIssued: "tokens.issued",
  TokenResent: "token.resent",
  TokenRecipientChanged: "token.recipient_changed",

  KeyRotatedOnRegistration: "voter.key_rotated_on_registration",
  KeyRotationRequested: "voter.key_rotation_requested",
  KeyRotationApproved: "voter.key_rotation_approved",
  KeyRotationRejected: "voter.key_rotation_rejected",

  AdminCreated: "admin.created",
  AdminRoleChanged: "admin.role_changed",
  AdminDeactivated: "admin.deactivated",
  AdminReactivated: "admin.reactivated",
  AdminPasswordChanged: "admin.password_changed",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
