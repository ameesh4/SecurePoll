import { countAuditEntries } from "../db/repository/auditLog.repository";
import { countUnassignedVoters } from "../db/repository/elections.repository";
import { countByStatus } from "../db/repository/registrations.repository";
import type { ElectionStatus } from "../db/schema";
import { evaluateTransitionGuards } from "./guards.service";
import { listElectionSummaries, type ElectionSummary } from "./election.service";
import { allowedTransitions } from "./lifecycle";

/**
 * One thing asking for the admin's attention, ranked so the dashboard can lead with it.
 *
 * Derived on the server rather than assembled in the browser because deciding what needs
 * attention means evaluating the same lifecycle guards the transitions themselves are gated
 * on — and a dashboard that says "ready to freeze" about an election the server would refuse
 * to freeze is worse than one that says nothing.
 */
export interface AttentionItem {
  key: string;
  severity: "action" | "waiting";
  title: string;
  detail: string;
  electionId: string | null;
  /** Where the admin should be sent, as a route the client understands. */
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
}

function nextForwardStage(status: ElectionStatus): ElectionStatus | null {
  const forward = allowedTransitions(status).filter((next) => next !== "CANCELLED");
  return forward[0] ?? null;
}

export async function getDashboard(): Promise<DashboardSummary> {
  // No ledger panel here: each election has its own network, so there is no single chain whose
  // health this could report.
  const [registrationCounts, auditEntries, elections] = await Promise.all([
    countByStatus(),
    countAuditEntries(),
    listElectionSummaries(),
  ]);

  const attention: AttentionItem[] = [];

  if (registrationCounts.PENDING > 0) {
    const openForRegistration = elections.filter(
      (entry) => entry.election.status === "REGISTRATION_OPEN",
    );
    attention.push({
      key: "registrations-waiting",
      severity: "action",
      title: `${registrationCounts.PENDING} registration${
        registrationCounts.PENDING === 1 ? "" : "s"
      } waiting on review`,
      detail: openForRegistration.length
        ? `${openForRegistration
            .map((entry) => entry.election.title)
            .join(", ")} ${openForRegistration.length === 1 ? "is" : "are"} still open for registration.`
        : "No election is currently open for registration, so these cannot be enfranchised yet.",
      electionId: openForRegistration[0]?.election.id ?? null,
      href: "/admin/registrations",
      actionLabel: "Open queue",
    });
  }

  // Each election is asked whether its next step would be permitted right now. This is the
  // same evaluation the transition performs, so what the dashboard promises and what the
  // server will accept cannot drift apart.
  const readiness = await Promise.all(
    elections.map(async (entry) => {
      const next = nextForwardStage(entry.election.status);
      if (!next) return null;
      const guards = await evaluateTransitionGuards(entry.election, next);
      return { entry, next, guards };
    }),
  );

  for (const item of readiness) {
    if (!item) continue;
    const { entry, next, guards } = item;

    if (next === "RINGS_FROZEN" && guards.passed) {
      attention.push({
        key: `close-registration-${entry.election.id}`,
        severity: "action",
        title: `${entry.election.title} is ready to close registration`,
        detail:
          "Every registration has been reviewed and the ballot has at least two candidates. Closing registration is irreversible and fixes the candidate list.",
        electionId: entry.election.id,
        href: `/admin/elections/${entry.election.id}`,
        actionLabel: "Review pre-flight",
      });
    }

    if (next === "VOTING_OPEN" && guards.passed) {
      attention.push({
        key: `open-voting-${entry.election.id}`,
        severity: "action",
        title: `${entry.election.title} is ready to open voting`,
        detail: `All ${guards.checks.length} guards pass. Opening voting cannot be undone.`,
        electionId: entry.election.id,
        href: `/admin/elections/${entry.election.id}`,
        actionLabel: "Review pre-flight",
      });
    }

    if (entry.election.status === "RINGS_FROZEN" && entry.counts.rings === 0) {
      attention.push({
        key: `form-rings-${entry.election.id}`,
        severity: "action",
        title: `${entry.election.title} needs anonymity groups`,
        detail: `${entry.counts.eligibleVoters} approved voters are not yet grouped. Voting cannot open until every one of them is in a published group.`,
        electionId: entry.election.id,
        href: `/admin/elections/${entry.election.id}/groups`,
        actionLabel: "Form groups",
      });
    }

    if (
      entry.election.status === "RINGS_FROZEN" &&
      entry.counts.rings > 0 &&
      entry.counts.ringsPublished < entry.counts.rings
    ) {
      attention.push({
        key: `publish-rings-${entry.election.id}`,
        severity: "action",
        title: `${entry.election.title} has unpublished groups`,
        detail: `${entry.counts.rings - entry.counts.ringsPublished} of ${
          entry.counts.rings
        } groups are not yet on the ledger. Freezing and publishing is irreversible.`,
        electionId: entry.election.id,
        href: `/admin/elections/${entry.election.id}/groups`,
        actionLabel: "Review pre-flight",
      });
    }

    if (
      entry.election.status === "VOTING_OPEN" &&
      entry.counts.tokensIssued < entry.counts.eligibleVoters
    ) {
      attention.push({
        key: `issue-tokens-${entry.election.id}`,
        severity: "action",
        title: `${entry.election.title} has voters without ballot access`,
        detail: `${
          entry.counts.eligibleVoters - entry.counts.tokensIssued
        } approved voters have not been sent a ballot link while voting is open.`,
        electionId: entry.election.id,
        href: `/admin/elections/${entry.election.id}/ballot-access`,
        actionLabel: "Send access",
      });
    }
  }

  // A voter in no group is the quietest way to disenfranchise somebody, so it is surfaced
  // even for elections whose next transition is otherwise blocked.
  const unassigned = await Promise.all(
    elections
      .filter((entry) => entry.election.status === "RINGS_FROZEN" && entry.counts.rings > 0)
      .map(async (entry) => ({
        entry,
        count: await countUnassignedVoters(entry.election.id),
      })),
  );

  for (const { entry, count } of unassigned) {
    if (count === 0) continue;
    attention.push({
      key: `unassigned-${entry.election.id}`,
      severity: "action",
      title: `${count} approved voters in ${entry.election.title} are in no group`,
      detail:
        "A voter who belongs to no published group holds a key no ring contains, so their ballot could never be counted. Re-form the groups before publishing.",
      electionId: entry.election.id,
      href: `/admin/elections/${entry.election.id}/groups`,
      actionLabel: "Re-form groups",
    });
  }

  return {
    pendingRegistrations: registrationCounts.PENDING,
    approvedVoters: registrationCounts.APPROVED,
    anonymityGroups: elections.reduce((total, entry) => total + entry.counts.rings, 0),
    auditEntries,
    attention,
    elections,
  };
}
