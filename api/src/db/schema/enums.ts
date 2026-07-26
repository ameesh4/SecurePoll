import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Election lifecycle. Transitions are enforced in the service layer:
 * DRAFT -> REGISTRATION_OPEN -> RINGS_FROZEN -> VOTING_OPEN -> VOTING_CLOSED -> TALLIED
 * with DRAFT and REGISTRATION_OPEN also able to move to CANCELLED.
 */
export const electionStatus = pgEnum("election_status", [
  "DRAFT",
  "REGISTRATION_OPEN",
  "RINGS_FROZEN",
  "VOTING_OPEN",
  "VOTING_CLOSED",
  "TALLIED",
  "CANCELLED",
]);

export const registrationStatus = pgEnum("registration_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

/**
 * What an admin is allowed to do. The split exists because the irreversible steps — freezing
 * ring membership, publishing rings to the ledger, opening and closing voting — cannot be
 * undone by anyone once taken, so they sit behind a second, smaller role rather than being
 * available to everyone who can vet a registration.
 */
export const adminRole = pgEnum("admin_role", ["REVIEWER", "SUPER_ADMIN"]);

/**
 * Delivery state of one ballot-access email. Dispatch is a queued job rather than part of
 * the issuing request, so every recipient carries its own status and an admin can see and
 * retry individual failures instead of re-sending the whole batch.
 */
export const emailDeliveryStatus = pgEnum("email_delivery_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "BOUNCED",
]);

/**
 * Review state of a voter's request to replace their voting key. Mirrors registration review,
 * because it is the same kind of decision: a person confirming that the person asking is who they
 * say they are.
 */
export const keyRotationStatus = pgEnum("key_rotation_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export type ElectionStatus = (typeof electionStatus.enumValues)[number];
export type RegistrationStatus = (typeof registrationStatus.enumValues)[number];
export type AdminRole = (typeof adminRole.enumValues)[number];
export type EmailDeliveryStatus = (typeof emailDeliveryStatus.enumValues)[number];
export type KeyRotationStatus = (typeof keyRotationStatus.enumValues)[number];
