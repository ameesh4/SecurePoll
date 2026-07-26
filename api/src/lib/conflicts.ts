import { ConflictError } from "./errors";

/** The three identifiers that must be unique across the system. */
export type ConflictField = "nationalId" | "email" | "publicKey";

export type ConflictFields = Record<ConflictField, boolean>;

export interface IdentityClaim {
  nationalId: string;
  email: string;
  publicKey: string;
}

export const NO_CONFLICTS: ConflictFields = {
  nationalId: false,
  email: false,
  publicKey: false,
};

export function conflictingFields(...results: ConflictFields[]): ConflictField[] {
  const fields: ConflictField[] = [];
  for (const field of ["nationalId", "email", "publicKey"] as const) {
    if (results.some((result) => result[field])) fields.push(field);
  }
  return fields;
}

const PG_UNIQUE_VIOLATION = "23505";

/**
 * Maps a unique index to the submitted field that violated it. Postgres reports the index
 * name in the error, which is why these index names are worth keeping descriptive.
 */
const FIELD_BY_CONSTRAINT: Record<string, ConflictField> = {
  registrations_national_id_live_unique: "nationalId",
  registrations_email_live_unique: "email",
  registrations_public_key_live_unique: "publicKey",
  voters_national_id_unique: "nationalId",
  voters_email_unique: "email",
  voters_public_key_unique: "publicKey",
};

/** How deep to follow `cause` before giving up. Guards against a cyclic chain. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Finds the driver-level error inside whatever the ORM threw.
 *
 * Drizzle wraps a failed statement in a `DrizzleQueryError` and hangs the original `DatabaseError`
 * off `cause`, so the Postgres error code is never on the object it throws. Reading `error.code`
 * directly therefore always misses — which is worth stating plainly, because it did: this function
 * silently returned null for every violation until the chain was walked.
 */
function findDriverError(
  error: unknown,
): { code?: unknown; constraint?: unknown } | null {
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === PG_UNIQUE_VIOLATION) return candidate;
    current = candidate.cause;
  }
  return null;
}

/**
 * Turns a unique-violation from the driver into the same ConflictError the pre-flight check
 * would have raised, or returns null if this was some other failure.
 *
 * Checking before inserting cannot be airtight: two submissions claiming the same national
 * id can both pass the check and only collide at insert. The unique indexes are the real
 * enforcement, and this exists so losing that race produces the same 409 as losing it by a
 * millisecond more would have, rather than a 500.
 */
export function asConflictError(error: unknown, message: string): ConflictError | null {
  const driverError = findDriverError(error);
  if (!driverError) return null;

  const constraint =
    typeof driverError.constraint === "string" ? driverError.constraint : undefined;
  const field = constraint ? FIELD_BY_CONSTRAINT[constraint] : undefined;

  return new ConflictError(message, { fields: field ? [field] : [] });
}
