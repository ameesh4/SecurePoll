import { request, requestText } from "./client";
import type {
  AdminAccount,
  AdminProfile,
  AdminRole,
  AuditPage,
  AvailableVoterPage,
  BallotAccessView,
  BulkOutcome,
  Candidate,
  CandidateList,
  CreatedAdmin,
  DashboardSummary,
  Election,
  ElectionDetail,
  ElectionStatus,
  ElectionSummary,
  ElectoratePage,
  EmailDeliveryStatus,
  GuardReport,
  KeyReplacementOutcome,
  KeyRotationPage,
  KeyRotationRequest,
  LoginResult,
  MonitoringSnapshot,
  PublishOutcome,
  Registration,
  RegistrationDetail,
  RegistrationQueue,
  RegistrationReceipt,
  RegistrationStatus,
  RegistrationStatusView,
  RemoveOutcome,
  RingDetail,
  RingPreview,
  RingRetrieval,
  TransferOutcome,
  TransitionPreview,
  Voter,
} from "./types";

export function submitRegistration(body: {
  fullName: string;
  nationalId: string;
  email: string;
  publicKey: string;
}): Promise<RegistrationReceipt> {
  return request<RegistrationReceipt>("/register", { method: "POST", body });
}

export function login(email: string, password: string): Promise<LoginResult> {
  return request<LoginResult>("/admin/auth/login", {
    method: "POST",
    body: { email, password },
  });
}

export function fetchCurrentAdmin(signal?: AbortSignal): Promise<AdminProfile> {
  return request<AdminProfile>("/admin/auth/me", { auth: true, signal });
}

export function fetchQueue(
  params: {
    status?: RegistrationStatus;
    search?: string;
    flaggedOnly?: boolean;
    page: number;
    pageSize: number;
  },
  signal?: AbortSignal,
): Promise<RegistrationQueue> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.search) query.set("search", params.search);
  if (params.flaggedOnly) query.set("flaggedOnly", "true");
  query.set("page", String(params.page));
  query.set("pageSize", String(params.pageSize));
  return request<RegistrationQueue>(`/admin/registrations?${query}`, {
    auth: true,
    signal,
  });
}

export function fetchRegistration(
  id: string,
  signal?: AbortSignal,
): Promise<RegistrationDetail> {
  return request<RegistrationDetail>(`/admin/registrations/${id}`, { auth: true, signal });
}

export function approveRegistration(
  id: string,
  electionId?: string,
): Promise<{ registration: Registration; voter: Voter }> {
  return request(`/admin/registrations/${id}/approve`, {
    method: "POST",
    auth: true,
    body: { electionId },
  });
}

export function rejectRegistration(
  id: string,
  reason: string,
): Promise<{ registration: Registration }> {
  return request(`/admin/registrations/${id}/reject`, {
    method: "POST",
    auth: true,
    body: { reason },
  });
}

/* ── Dashboard ─────────────────────────────────────────────────────────────────────────── */

export function fetchDashboard(signal?: AbortSignal): Promise<DashboardSummary> {
  return request<DashboardSummary>("/admin/dashboard", { auth: true, signal });
}

/* ── Elections ─────────────────────────────────────────────────────────────────────────── */

export function fetchElections(signal?: AbortSignal): Promise<{ items: ElectionSummary[] }> {
  return request("/admin/elections", { auth: true, signal });
}

export function fetchElection(id: string, signal?: AbortSignal): Promise<ElectionDetail> {
  return request(`/admin/elections/${id}`, { auth: true, signal });
}

export interface ElectionDraft {
  title: string;
  description?: string | null;
  registrationOpensAt?: string | null;
  registrationClosesAt?: string | null;
  votingOpensAt?: string | null;
  votingClosesAt?: string | null;
  ringSize?: number;
  /** Root node of this election'''s own ledger network. */
  chainRootIp?: string | null;
  chainRootPort?: number | null;
}

export function createElection(body: ElectionDraft): Promise<{ election: Election }> {
  return request("/admin/elections", { method: "POST", auth: true, body });
}

export function updateElection(
  id: string,
  body: Partial<ElectionDraft>,
): Promise<{ election: Election }> {
  return request(`/admin/elections/${id}`, { method: "PATCH", auth: true, body });
}

/** Read-only pre-flight. The transition re-checks every guard under a lock. */
export function previewTransition(
  id: string,
  to: ElectionStatus,
  signal?: AbortSignal,
): Promise<TransitionPreview> {
  return request(`/admin/elections/${id}/transition?to=${to}`, { auth: true, signal });
}

export function transitionElection(
  id: string,
  to: ElectionStatus,
): Promise<{ election: Election }> {
  return request(`/admin/elections/${id}/transition`, {
    method: "POST",
    auth: true,
    body: { to },
  });
}

/* ── Candidates ────────────────────────────────────────────────────────────────────────── */

export function fetchCandidates(
  electionId: string,
  signal?: AbortSignal,
): Promise<CandidateList> {
  return request(`/admin/elections/${electionId}/candidates`, { auth: true, signal });
}

export interface CandidateDraft {
  name: string;
  affiliation?: string | null;
  photoUrl?: string | null;
  ballotPosition?: number;
}

export function createCandidate(
  electionId: string,
  body: CandidateDraft,
): Promise<{ candidate: Candidate }> {
  return request(`/admin/elections/${electionId}/candidates`, {
    method: "POST",
    auth: true,
    body,
  });
}

export function updateCandidate(
  candidateId: string,
  body: Partial<CandidateDraft>,
): Promise<{ candidate: Candidate }> {
  return request(`/admin/candidates/${candidateId}`, { method: "PATCH", auth: true, body });
}

export function deleteCandidate(candidateId: string): Promise<{ ok: boolean }> {
  return request(`/admin/candidates/${candidateId}`, { method: "DELETE", auth: true });
}

export function reorderCandidates(
  electionId: string,
  candidateIds: string[],
): Promise<{ candidates: Candidate[] }> {
  return request(`/admin/elections/${electionId}/candidates/reorder`, {
    method: "POST",
    auth: true,
    body: { candidateIds },
  });
}

/* ── Anonymity groups ──────────────────────────────────────────────────────────────────── */

export function fetchRingPreview(
  electionId: string,
  signal?: AbortSignal,
): Promise<RingPreview> {
  return request(`/admin/elections/${electionId}/rings/preview`, { auth: true, signal });
}

export function formRings(electionId: string): Promise<RingPreview> {
  return request(`/admin/elections/${electionId}/rings/form`, { method: "POST", auth: true });
}

export function fetchRings(
  electionId: string,
  params: { page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<{ items: RingDetail[]; total: number; page: number; totalPages: number }> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  return request(`/admin/elections/${electionId}/rings?${query}`, { auth: true, signal });
}

export function previewPublish(
  electionId: string,
  signal?: AbortSignal,
): Promise<GuardReport> {
  return request(`/admin/elections/${electionId}/rings/publish`, { auth: true, signal });
}

/** Irreversible. Super-admin only, enforced server-side. */
export function publishRings(electionId: string): Promise<PublishOutcome> {
  return request(`/admin/elections/${electionId}/rings/publish`, {
    method: "POST",
    auth: true,
  });
}

/* ── Ballot access ─────────────────────────────────────────────────────────────────────── */

export function fetchBallotAccess(
  electionId: string,
  params: {
    status?: EmailDeliveryStatus;
    search?: string;
    page: number;
    pageSize: number;
  },
  signal?: AbortSignal,
): Promise<BallotAccessView> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.search) query.set("search", params.search);
  query.set("page", String(params.page));
  query.set("pageSize", String(params.pageSize));
  return request(`/admin/elections/${electionId}/ballot-access?${query}`, {
    auth: true,
    signal,
  });
}

export function issueBallotAccess(
  electionId: string,
): Promise<{ issued: number; skipped: number; queued: number }> {
  return request(`/admin/elections/${electionId}/ballot-access/issue`, {
    method: "POST",
    auth: true,
  });
}

export function dispatchBallotAccess(electionId: string): Promise<{ attempted: number }> {
  return request(`/admin/elections/${electionId}/ballot-access/dispatch`, {
    method: "POST",
    auth: true,
  });
}

export function retryBallotAccess(electionId: string): Promise<{ requeued: number }> {
  return request(`/admin/elections/${electionId}/ballot-access/retry`, {
    method: "POST",
    auth: true,
  });
}

export function resendBallotAccess(tokenId: string): Promise<{ status: string }> {
  return request(`/admin/ballot-access/${tokenId}/resend`, { method: "POST", auth: true });
}

export function changeBallotRecipient(
  tokenId: string,
  email: string,
): Promise<{ id: string; deliverTo: string; emailStatus: EmailDeliveryStatus }> {
  return request(`/admin/ballot-access/${tokenId}/recipient`, {
    method: "PATCH",
    auth: true,
    body: { email },
  });
}

/* ── Monitoring ────────────────────────────────────────────────────────────────────────── */

export function fetchMonitoring(
  electionId: string,
  signal?: AbortSignal,
): Promise<MonitoringSnapshot> {
  return request(`/admin/elections/${electionId}/monitoring`, { auth: true, signal });
}

/* ── Electorate ────────────────────────────────────────────────────────────────────────── */

export function fetchElectorate(
  electionId: string,
  params: { search?: string; page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<ElectoratePage> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  query.set("page", String(params.page));
  query.set("pageSize", String(params.pageSize));
  return request(`/admin/elections/${electionId}/voters?${query}`, { auth: true, signal });
}

/* ── Audit ─────────────────────────────────────────────────────────────────────────────── */

export interface AuditFilters {
  electionId?: string;
  adminId?: string;
  action?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export function fetchAudit(
  filters: AuditFilters,
  signal?: AbortSignal,
): Promise<AuditPage> {
  const query = new URLSearchParams();
  if (filters.electionId) query.set("electionId", filters.electionId);
  if (filters.adminId) query.set("adminId", filters.adminId);
  if (filters.action) query.set("action", filters.action);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  query.set("page", String(filters.page));
  query.set("pageSize", String(filters.pageSize));
  return request(`/admin/audit?${query}`, { auth: true, signal });
}

export function fetchElectionAudit(
  electionId: string,
  params: { page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<AuditPage> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  return request(`/admin/elections/${electionId}/audit?${query}`, { auth: true, signal });
}

/* ── Review queue ──────────────────────────────────────────────────────────────────────── */

export function approveRegistrations(
  registrationIds: string[],
  electionId?: string,
): Promise<BulkOutcome> {
  return request("/admin/registrations/bulk/approve", {
    method: "POST",
    auth: true,
    body: { registrationIds, electionId },
  });
}

export function rejectRegistrationsBulk(
  registrationIds: string[],
  reason: string,
): Promise<BulkOutcome> {
  return request("/admin/registrations/bulk/reject", {
    method: "POST",
    auth: true,
    body: { registrationIds, reason },
  });
}

/* ── Public ────────────────────────────────────────────────────────────────────────────── */

/**
 * The voter's own status page. Unauthenticated: the id in the path is what authorises it, and
 * it reaches only the person who submitted the form.
 */
export function fetchRegistrationStatus(
  id: string,
  signal?: AbortSignal,
): Promise<RegistrationStatusView> {
  return request(`/register/${id}`, { signal });
}

/**
 * Vetted voters not yet on this election's roll — the pool for bulk transfer.
 *
 * Everyone here has already passed the review queue once, so enrolling them is a per-election
 * decision rather than a fresh identity check.
 */
export function fetchAvailableVoters(
  electionId: string,
  params: { search?: string; page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<AvailableVoterPage> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  query.set("page", String(params.page));
  query.set("pageSize", String(params.pageSize));
  return request(`/admin/elections/${electionId}/voters/available?${query}`, {
    auth: true,
    signal,
  });
}

export function transferVotersOntoRoll(
  electionId: string,
  voterIds: string[],
): Promise<TransferOutcome> {
  return request(`/admin/elections/${electionId}/eligibility/bulk`, {
    method: "POST",
    auth: true,
    body: { voterIds, eligible: true },
  });
}

export function removeVotersFromRoll(
  electionId: string,
  voterIds: string[],
): Promise<RemoveOutcome> {
  return request(`/admin/elections/${electionId}/eligibility/bulk`, {
    method: "POST",
    auth: true,
    body: { voterIds, eligible: false },
  });
}

/**
 * Replaces the voting key on a registration.
 *
 * Sends the public half only. The private key stays on this device — there is no field for it on
 * this request and no column for it on the server.
 */
export function replaceVotingKey(
  registrationId: string,
  publicKey: string,
  reason?: string,
): Promise<KeyReplacementOutcome> {
  return request(`/register/${registrationId}/key`, {
    method: "POST",
    body: { publicKey, reason },
  });
}

export function fetchKeyRotations(
  params: { page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<KeyRotationPage> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  return request(`/admin/key-rotations?${query}`, { auth: true, signal });
}

export function reviewKeyRotation(
  requestId: string,
  approve: boolean,
  rejectionReason?: string,
): Promise<{ request: KeyRotationRequest }> {
  return request(`/admin/key-rotations/${requestId}/review`, {
    method: "POST",
    auth: true,
    body: { approve, rejectionReason },
  });
}

/* ── Operator accounts ─────────────────────────────────────────────────────────────────── */

export function fetchAdmins(signal?: AbortSignal): Promise<{ items: AdminAccount[] }> {
  return request("/admin/admins", { auth: true, signal });
}

export function createAdminAccount(body: {
  name: string;
  email: string;
  role: AdminRole;
}): Promise<CreatedAdmin> {
  return request("/admin/admins", { method: "POST", auth: true, body });
}

export function updateAdminAccount(
  id: string,
  body: { role?: AdminRole; isActive?: boolean },
): Promise<{ admin: AdminAccount }> {
  return request(`/admin/admins/${id}`, { method: "PATCH", auth: true, body });
}

export function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean }> {
  return request("/admin/auth/password", {
    method: "POST",
    auth: true,
    body: { currentPassword, newPassword },
  });
}

/**
 * Downloads the election manifest a ledger node imports from disk.
 *
 * Returns the raw bytes and the server's suggested filename; see
 * `blockchain/ELECTION_MANIFEST.md` for the format and `X-Manifest-Digest` for the digest the
 * server recorded against each group.
 */
export function fetchChainManifest(
  electionId: string,
): Promise<{ body: string; filename: string | null }> {
  return requestText(`/admin/elections/${electionId}/chain-manifest`, { auth: true });
}

/* ── Voter: collecting a ballot ────────────────────────────────────────────────────────── */

/**
 * Spends a ballot-access credential for the voter's anonymity group.
 *
 * Unauthenticated: the token in the body *is* the authorisation. Idempotent until the token
 * expires, so a reload or a failed submission is recoverable rather than a lockout.
 */
export function collectBallot(token: string): Promise<RingRetrieval> {
  return request("/ring", { method: "POST", body: { token } });
}
