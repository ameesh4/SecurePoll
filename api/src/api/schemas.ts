import { z } from "zod";
import { describeVoterPublicKey } from "../lib/publicKey";

const publicKeySchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const problem = describeVoterPublicKey(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const registrationSubmissionSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is too short").max(120),
  nationalId: z
    .string()
    .trim()
    .min(4, "National id is too short")
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9\-/]*$/, "National id contains unsupported characters"),
  email: z.email("Enter a valid email address").max(254),
  publicKey: publicKeySchema,
});

export const adminLoginSchema = z.object({
  email: z.email("Enter a valid email address").max(254),
  password: z.string().min(1, "Password is required").max(200),
});

export const registrationQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  // Sent as a query string, so "false" has to be handled explicitly — `Boolean("false")` is
  // true, which would silently pin the queue to the flagged subset.
  flaggedOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const rejectionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Give the voter a usable reason")
    .max(500, "Keep the reason under 500 characters"),
});

export const uuidParamSchema = z.object({ id: z.uuid("Not a valid identifier") });

/* ── Elections ─────────────────────────────────────────────────────────────────────────── */

/**
 * Timestamps arrive as ISO strings. Coerced rather than accepted as `z.date()` because the
 * wire format is JSON and JSON has no date type; a bare `z.date()` would reject every real
 * request.
 */
const isoDate = z.coerce.date();

/**
 * Ballot positions are capped well below the offset the reorder uses to park rows out of the
 * way. Without this cap a hand-crafted position of 10_001 could collide with a parked row
 * mid-reorder and fail the unique index.
 */
const ballotPositionSchema = z.coerce.number().int().min(1).max(999);

export const electionCreateSchema = z.object({
  title: z.string().trim().min(3, "Give the election a title").max(200),
  description: z.string().trim().max(2000).nullish(),
  registrationOpensAt: isoDate.nullish(),
  registrationClosesAt: isoDate.nullish(),
  votingOpensAt: isoDate.nullish(),
  votingClosesAt: isoDate.nullish(),
  // The floor of 2 is the schema's absolute minimum; the real policy minimum is enforced
  // against RING_MIN_SIZE in the ring service, which is where the number is meaningful.
  ringSize: z.coerce.number().int().min(2).max(1000).optional(),
});

export const electionUpdateSchema = electionCreateSchema.partial();

export const electionTransitionSchema = z.object({
  to: z.enum([
    "REGISTRATION_OPEN",
    "RINGS_FROZEN",
    "VOTING_OPEN",
    "VOTING_CLOSED",
    "TALLIED",
    "CANCELLED",
  ]),
});

/* ── Candidates ────────────────────────────────────────────────────────────────────────── */

export const candidateCreateSchema = z.object({
  office: z.string().trim().min(2, "Name the office being contested").max(120),
  name: z.string().trim().min(2, "Give the candidate's full name").max(160),
  affiliation: z.string().trim().max(160).nullish(),
  photoUrl: z.url("Enter a valid URL").max(500).nullish(),
  ballotPosition: ballotPositionSchema.optional(),
});

export const candidateUpdateSchema = candidateCreateSchema.partial();

export const candidateReorderSchema = z.object({
  office: z.string().trim().min(2).max(120),
  candidateIds: z.array(z.uuid()).min(1, "List the candidates in their new order"),
});

/* ── Review queue ──────────────────────────────────────────────────────────────────────── */

/**
 * Approving names the election the voter is being enfranchised for. Optional, because a voter
 * can legitimately be vetted without being placed on any roll — but the queue always sends it.
 */
export const approvalSchema = z.object({
  electionId: z.uuid("Not a valid election").optional(),
});

export const bulkApprovalSchema = z.object({
  registrationIds: z
    .array(z.uuid())
    .min(1, "Select at least one registration")
    // Bounded so one request cannot pin the process for minutes: each approval is its own
    // transaction, so a very long list would hold the connection open the whole time.
    .max(200, "Approve at most 200 registrations at a time"),
  electionId: z.uuid("Not a valid election").optional(),
});

export const bulkRejectionSchema = bulkApprovalSchema
  .omit({ electionId: true })
  .extend(rejectionSchema.shape);

/* ── Rings ─────────────────────────────────────────────────────────────────────────────── */

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/* ── Ballot access ─────────────────────────────────────────────────────────────────────── */

export const tokenQuerySchema = paginationSchema.extend({
  status: z.enum(["PENDING", "SENT", "FAILED", "BOUNCED"]).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

export const recipientChangeSchema = z.object({
  email: z.email("Enter a valid email address").max(254),
});

/**
 * The credential presented to `POST /api/ring`. Length- and charset-bounded so an absurd
 * payload is rejected before it reaches a hash, but deliberately not validated any further —
 * the token is opaque, and a more specific error would tell an unauthenticated caller
 * something about what a real one looks like.
 */
export const ringRetrievalSchema = z.object({
  token: z
    .string()
    .trim()
    .min(16, "That does not look like a ballot access link")
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/, "That does not look like a ballot access link"),
});

/* ── Eligibility ───────────────────────────────────────────────────────────────────────── */

export const eligibilitySchema = z.object({
  voterId: z.uuid("Not a valid voter"),
  eligible: z.boolean(),
});

export const voterQuerySchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
});

/* ── Audit ─────────────────────────────────────────────────────────────────────────────── */

export const auditQuerySchema = paginationSchema.extend({
  electionId: z.uuid().optional(),
  adminId: z.uuid().optional(),
  action: z.string().trim().min(1).max(80).optional(),
  entityType: z.string().trim().min(1).max(40).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/**
 * Bulk enrolment. Capped so one request cannot hold a transaction open over an unbounded write —
 * larger rolls are transferred a page at a time, which the interface does anyway.
 */
export const bulkEligibilitySchema = z.object({
  voterIds: z
    .array(z.uuid("Not a valid voter"))
    .min(1, "Select at least one voter")
    .max(500, "Transfer at most 500 voters at a time"),
  eligible: z.boolean().default(true),
});

/**
 * A voter's request to replace their voting key.
 *
 * The public half only. There is deliberately no field here for a private key, seed or mnemonic,
 * and adding one would break the invariant the whole scheme rests on.
 */
export const keyReplacementSchema = z.object({
  publicKey: publicKeySchema,
  reason: z.string().trim().max(500).optional(),
});

export const keyRotationReviewSchema = z.object({
  approve: z.boolean(),
  rejectionReason: z.string().trim().min(3).max(500).optional(),
});

/* ── Operator accounts ─────────────────────────────────────────────────────────────────── */

/**
 * Creating an operator. Note the absence of a password field: the initial one is generated
 * server-side and returned once, so a creator cannot choose a weak value for somebody else, and
 * nothing here transmits a chosen credential.
 */
export const adminCreateSchema = z.object({
  name: z.string().trim().min(2, "Give the operator a name").max(120),
  email: z.email("Enter a valid email address").max(254),
  role: z.enum(["REVIEWER", "SUPER_ADMIN"]),
});

export const adminUpdateSchema = z
  .object({
    role: z.enum(["REVIEWER", "SUPER_ADMIN"]).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.isActive !== undefined, {
    message: "Nothing to change",
  });

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newPassword: z.string().min(12, "At least 12 characters").max(200),
});
