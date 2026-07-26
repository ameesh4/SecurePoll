import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  admins: {
    auditEntries: r.many.auditLog(),
  },
  auditLog: {
    admin: r.one.admins({
      from: r.auditLog.adminId,
      to: r.admins.id,
      optional: true,
    }),
    election: r.one.elections({
      from: r.auditLog.electionId,
      to: r.elections.id,
      optional: true,
    }),
  },
  elections: {
    eligibleVoters: r.many.electionEligibility(),
    rings: r.many.rings(),
    candidates: r.many.candidates(),
    ballotAccessTokens: r.many.ballotAccessTokens(),
    auditEntries: r.many.auditLog(),
  },
  candidates: {
    election: r.one.elections({
      from: r.candidates.electionId,
      to: r.elections.id,
      optional: false,
    }),
  },
  voters: {
    /** Normally one row, but a rejected attempt followed by a later approval yields two. */
    registrations: r.many.registrations(),
    eligibilities: r.many.electionEligibility(),
    ringMemberships: r.many.ringMembers(),
    ballotAccessTokens: r.many.ballotAccessTokens(),
    keyRotationRequests: r.many.keyRotationRequests(),
  },
  keyRotationRequests: {
    registration: r.one.registrations({
      from: r.keyRotationRequests.registrationId,
      to: r.registrations.id,
      optional: false,
    }),
    voter: r.one.voters({
      from: r.keyRotationRequests.voterId,
      to: r.voters.id,
      optional: false,
    }),
    reviewedBy: r.one.admins({
      from: r.keyRotationRequests.reviewedByAdminId,
      to: r.admins.id,
      optional: true,
    }),
  },
  ballotAccessTokens: {
    election: r.one.elections({
      from: r.ballotAccessTokens.electionId,
      to: r.elections.id,
      optional: false,
    }),
    voter: r.one.voters({
      from: r.ballotAccessTokens.voterId,
      to: r.voters.id,
      optional: false,
    }),
  },
  registrations: {
    voter: r.one.voters({
      from: r.registrations.voterId,
      to: r.voters.id,
      optional: true,
    }),
  },
  electionEligibility: {
    election: r.one.elections({
      from: r.electionEligibility.electionId,
      to: r.elections.id,
      optional: false,
    }),
    voter: r.one.voters({
      from: r.electionEligibility.voterId,
      to: r.voters.id,
      optional: false,
    }),
  },
  rings: {
    election: r.one.elections({
      from: r.rings.electionId,
      to: r.elections.id,
      optional: false,
    }),
    members: r.many.ringMembers(),
  },
  ringMembers: {
    ring: r.one.rings({
      from: r.ringMembers.ringId,
      to: r.rings.id,
      optional: false,
    }),
    voter: r.one.voters({
      from: r.ringMembers.voterId,
      to: r.voters.id,
      optional: false,
    }),
  },
}));
