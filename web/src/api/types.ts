export type RegistrationStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface Registration {
  id: string;
  fullName: string;
  nationalId: string;
  email: string;
  publicKey: string;
  status: RegistrationStatus;
  rejectionReason: string | null;
  reviewedAt: string | null;
  voterId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateWarning {
  field: "nationalId" | "email" | "publicKey";
  against: "registration" | "voter";
  recordId: string;
  detail: string;
}

export interface RegistrationDetail {
  registration: Registration;
  warnings: DuplicateWarning[];
}

export interface QueueRow extends Registration {
  /**
   * Which identifiers collide with another live record or a vetted voter. Computed server-side
   * so the bulk-approve guard ("no flags in selection") rests on one response, not on N.
   */
  duplicateFields: ("nationalId" | "email" | "publicKey")[];
}

export interface RegistrationQueue {
  items: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counts: Record<RegistrationStatus, number>;
  /** Pending records carrying a duplicate flag. */
  flagged: number;
}

export interface AdminProfile {
  id: string;
  name: string;
  email: string;
  /**
   * Drives which irreversible controls are offered. The server checks it again on every such
   * request, so hiding a button here is presentation, never the enforcement.
   */
  role: AdminRole;
}

export interface LoginResult {
  token: string;
  expiresIn: number;
  admin: AdminProfile;
}

export interface Voter {
  id: string;
  fullName: string;
  nationalId: string;
  email: string;
  publicKey: string;
  createdAt: string;
}

export interface RegistrationReceipt {
  id: string;
  status: RegistrationStatus;
  submittedAt: string;
}

/* ── Lifecycle ─────────────────────────────────────────────────────────────────────────── */

export type ElectionStatus =
  | "DRAFT"
  | "REGISTRATION_OPEN"
  | "RINGS_FROZEN"
  | "VOTING_OPEN"
  | "VOTING_CLOSED"
  | "TALLIED"
  | "CANCELLED";

export type AdminRole = "REVIEWER" | "SUPER_ADMIN";

export type ElectionOperation =
  | "editMetadata"
  | "manageCandidates"
  | "reviewVoters"
  | "formRings"
  | "publishRings"
  | "issueTokens"
  | "exportChainManifest"
  | "viewTally";

export interface Election {
  id: string;
  title: string;
  description: string | null;
  status: ElectionStatus;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  votingOpensAt: string | null;
  votingClosesAt: string | null;
  ringSize: number;
  /** Root node of this election's own ledger network. */
  chainRootIp: string | null;
  chainRootPort: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ElectionCounts {
  electionId: string;
  eligibleVoters: number;
  candidates: number;
  rings: number;
  ringsPublished: number;
  ringMembers: number;
  tokensIssued: number;
  tokensRedeemed: number;
}

export interface ElectionSummary {
  election: Election;
  counts: ElectionCounts;
}

/** One pre-flight condition, as the server evaluated it. Never re-derived in the browser. */
export interface GuardCheck {
  key: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface GuardReport {
  checks: GuardCheck[];
  passed: boolean;
}

export interface TransitionPreview extends GuardReport {
  irreversible: boolean;
}

export interface ElectionDetail extends ElectionSummary {
  operations: Record<ElectionOperation, boolean>;
  transitions: ElectionStatus[];
  guards: GuardReport;
  unassignedVoters: number;
  /** Names on the ballot. The "at least 2 candidates" guard is decided on this. */
  candidateCount: number;
}

/* ── Candidates ────────────────────────────────────────────────────────────────────────── */

export interface Candidate {
  id: string;
  electionId: string;
  name: string;
  affiliation: string | null;
  photoUrl: string | null;
  ballotPosition: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The ballot: one flat, ordered list.
 *
 * There is no grouping by office. A voter has one key image per election, so exactly one ballot
 * with one candidateId can ever be accepted — several seats in one election could never be voted.
 * One election is one contest.
 */
export interface CandidateList {
  candidates: Candidate[];
  belowMinimum: boolean;
}

/* ── Ballot collection ─────────────────────────────────────────────────────────────────── */

/**
 * What a ballot-access credential buys: the anonymity group the bearer belongs to.
 *
 * Note what is absent — the caller's own index in `publicKeys`. The server refuses to say which
 * member is you; the client derives its public key from the key file and finds itself. An index
 * returned here would be a server-side record of exactly which ring member was about to sign.
 */
export interface RingRetrieval {
  electionId: string;
  electionTitle: string;
  ringId: string;
  /**
   * Root node of this election's own ledger network — where the signed ballot goes. Null when no
   * ledger has been recorded for the election, in which case there is nowhere to cast.
   */
  nodeUrl: string | null;
  /** Ordered exactly as published. Reordering breaks every signature against this group. */
  publicKeys: string[];
  candidates: {
    id: string;
    name: string;
    affiliation: string | null;
    photoUrl: string | null;
    ballotPosition: number;
  }[];
}

/* ── Dashboard ─────────────────────────────────────────────────────────────────────────── */

export interface AttentionItem {
  key: string;
  severity: "action" | "waiting";
  title: string;
  detail: string;
  electionId: string | null;
  href: string;
  actionLabel: string;
}

export interface DashboardSummary {
  pendingRegistrations: number;
  approvedVoters: number;
  anonymityGroups: number;
  auditEntries: number;
  attention: AttentionItem[];
  elections: ElectionSummary[];
  stages: { status: ElectionStatus; label: string }[];
}

/* ── Anonymity groups ──────────────────────────────────────────────────────────────────── */

export interface RingPreviewGroup {
  index: number;
  size: number;
  redistributed: number;
  published: boolean;
  ringId?: string;
}

export interface RingPreview {
  electionId: string;
  targetSize: number;
  minimumSize: number;
  voters: number;
  groups: number;
  smallestSize: number;
  largestSize: number;
  unassignedVoters: number;
  redistributedVoters: number;
  fingerprint: string;
  published: boolean;
  publishedGroups: number;
  warnings: string[];
  sample: RingPreviewGroup[];
}

export interface RingDetail {
  index: number;
  ringId: string;
  size: number;
  published: boolean;
  publishedAt: string | null;
  chainTxRef: string | null;
  redistributed: number;
}

export interface PublishOutcome {
  publishedGroups: number;
  alreadyPublished: number;
  failed: { ringId: string; index: number; reason: string }[];
}

/* ── Ballot access ─────────────────────────────────────────────────────────────────────── */

export type EmailDeliveryStatus = "PENDING" | "SENT" | "FAILED" | "BOUNCED";

export interface BallotAccessRow {
  id: string;
  voterId: string;
  fullName: string;
  deliverTo: string;
  emailStatus: EmailDeliveryStatus;
  deliveryAttempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** That access was collected. Never what was voted — no such field exists server-side. */
  accessUsed: boolean;
  redeemedAt: string | null;
  expiresAt: string;
}

export interface DispatchSummary {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  bounced: number;
  redeemed: number;
}

export interface BallotAccessView {
  summary: DispatchSummary;
  items: BallotAccessRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  resendLimit: { max: number; windowMinutes: number };
  expiresAt: string | null;
}

/* ── Monitoring ────────────────────────────────────────────────────────────────────────── */

export interface MonitoringSnapshot {
  election: Election;
  counts: ElectionCounts;
  rings: { total: number; published: number };
  rejectedSubmissions: number | null;
  /** Read from the ledger, and only once voting has closed. Null while voting is open. */
  tally: Record<string, number> | null;
}

/* ── Audit ─────────────────────────────────────────────────────────────────────────────── */

export interface AuditEntry {
  id: string;
  adminId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  electionId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditRow {
  entry: AuditEntry;
  actor: { id: string; name: string; email: string; role: string } | null;
}

export interface AuditPage {
  items: AuditRow[];
  total: number;
  totalEntries?: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/* ── Electorate ────────────────────────────────────────────────────────────────────────── */

export interface ElectorateRow {
  voter: Voter;
  ringIndex: number | null;
}

export interface ElectoratePage {
  items: ElectorateRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/* ── Bulk review ───────────────────────────────────────────────────────────────────────── */

export interface BulkOutcome {
  approved: string[];
  rejected: string[];
  failed: { registrationId: string; reason: string }[];
}

/* ── Voter status ──────────────────────────────────────────────────────────────────────── */

export interface RegistrationStatusView {
  id: string;
  reference: string;
  status: RegistrationStatus;
  fullName: string;
  submittedAt: string;
  reviewedAt: string | null;
  rejectionReason: string | null;
  registrationClosesAt: string | null;
  votingOpensAt: string | null;
  votingClosesAt: string | null;
  electionTitle: string | null;
  anonymityGroupSize: number | null;
  keyReplacement: KeyReplacementAvailability;
}

export interface KeyReplacementAvailability {
  available: boolean;
  /** A replacement is already waiting for an officer to review it. */
  pendingRequest: boolean;
  /** True when it takes effect at once — the registration has not been reviewed yet. */
  immediate: boolean;
  reason?: string;
  appliesTo: { id: string; title: string }[];
  /** Elections whose groups are already frozen against the old key. */
  alreadyFrozen: { id: string; title: string; status: string }[];
}

export interface KeyReplacementOutcome {
  applied: boolean;
  requestId?: string;
  eligibility: KeyReplacementAvailability;
}

export interface KeyRotationRequest {
  id: string;
  registrationId: string;
  voterId: string;
  newPublicKey: string;
  previousPublicKey: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string | null;
  rejectionReason: string | null;
  reviewedByAdminId: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface KeyRotationRow {
  request: KeyRotationRequest;
  voter: Voter;
  registration: Registration;
}

export interface KeyRotationPage {
  items: KeyRotationRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AvailableVoterRow {
  voter: Voter;
  /** How many other elections this voter has been on the roll for. Context, not a filter. */
  pastElections: number;
}

export interface AvailableVoterPage {
  items: AvailableVoterRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface TransferOutcome {
  added: string[];
  alreadyOnRoll: string[];
  total: number;
}

export interface RemoveOutcome {
  removed: string[];
  /** Refused: their key is already published in a ring, so enrolment cannot be undone. */
  lockedIntoRings: string[];
}

/* ── Operator accounts ─────────────────────────────────────────────────────────────────── */

export interface AdminAccount {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface CreatedAdmin {
  admin: AdminAccount;
  /**
   * Shown exactly once. Only the hash is stored, so no endpoint can return it again — the screen
   * that receives this has to display it and say so.
   */
  initialPassword: string;
}
