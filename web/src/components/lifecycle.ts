import type { ElectionStatus } from "../api/types";

/**
 * Display names for lifecycle states, in the vocabulary the whole interface uses.
 *
 * Rings are "anonymity groups" everywhere a person can read it. Not decoration: an admin being
 * asked to confirm something irreversible has to understand what they are confirming, and
 * "freeze the LSAG rings" does not communicate "3,204 people are now locked into their groups".
 *
 * Kept in its own module rather than beside the rail component so that importing the labels does
 * not drag a component into a non-component file (and break fast refresh).
 */
export const STATUS_LABELS: Record<ElectionStatus, string> = {
  DRAFT: "Draft",
  REGISTRATION_OPEN: "Registration open",
  RINGS_FROZEN: "Groups frozen",
  VOTING_OPEN: "Voting open",
  VOTING_CLOSED: "Voting closed",
  TALLIED: "Tallied",
  CANCELLED: "Cancelled",
};

export const LIFECYCLE_STAGES: {
  status: ElectionStatus;
  label: string;
  note: string;
}[] = [
  { status: "DRAFT", label: "Draft", note: "editable" },
  { status: "REGISTRATION_OPEN", label: "Registration open", note: "voters reviewed" },
  { status: "RINGS_FROZEN", label: "Groups frozen", note: "irreversible" },
  { status: "VOTING_OPEN", label: "Voting open", note: "ballots accepted" },
  { status: "VOTING_CLOSED", label: "Voting closed", note: "access expires" },
  { status: "TALLIED", label: "Tallied", note: "result published" },
];
