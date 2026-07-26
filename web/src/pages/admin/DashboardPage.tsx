import { useCallback } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../api/client";
import { fetchDashboard } from "../../api/endpoints";
import type { ElectionSummary } from "../../api/types";
import { STATUS_LABELS } from "../../components/lifecycle";
import {
  Alert,
  Empty,
  Label,
  PageHeader,
  SectionRule,
  Stat,
  StatStrip,
  Tag,
} from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import { btn, btnSecondary, table, td, th } from "../../ui/classes";

function toMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Could not load the dashboard.";
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
};

function formatWhen(value: string | null): string {
  if (!value) return "not set";
  return new Date(value).toLocaleString("en-GB", DATE_FORMAT);
}

/** Elections in a live stage read as accent; settled ones read as neutral. */
function toneFor(status: ElectionSummary["election"]["status"]) {
  if (status === "REGISTRATION_OPEN") return "accent" as const;
  if (status === "VOTING_OPEN") return "outline" as const;
  return "neutral" as const;
}

function groupsCell(entry: ElectionSummary): string {
  const { rings, ringsPublished } = entry.counts;
  if (rings === 0) return "—";
  if (ringsPublished === rings) return `${rings} published`;
  if (ringsPublished === 0) return `${rings} unpublished`;
  return `${ringsPublished} of ${rings} published`;
}

function accessCell(entry: ElectionSummary): string {
  const { tokensIssued, tokensRedeemed } = entry.counts;
  if (tokensIssued === 0) return "—";
  return `${tokensIssued.toLocaleString()} sent · ${tokensRedeemed.toLocaleString()} used`;
}

export default function DashboardPage() {
  const load = useCallback((signal: AbortSignal) => fetchDashboard(signal), []);
  const { data, error, loading } = useAsyncData(load, toMessage);

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <>
      <PageHeader
        title="Dashboard"
        meta={
          <span className="text-[12.5px] text-ink/55">
            {today} · all times {zone}
          </span>
        }
        actions={
          <>
            <Link to="/admin/audit" className={`${btnSecondary} no-underline`}>
              Audit record
            </Link>
            <Link to="/admin/elections/new" className={`${btn} no-underline`}>
              New election
            </Link>
          </>
        }
      />

      {error ? (
        <div className="px-7 py-6">
          <Alert title="Could not load">{error}</Alert>
        </div>
      ) : null}

      {!data ? (
        loading ? (
          <p className="px-7 py-6 text-[13px] text-ink/55">Loading…</p>
        ) : null
      ) : (
        <>
          <StatStrip>
            <Stat
              label="Awaiting review"
              value={data.pendingRegistrations.toLocaleString()}
              accent={data.pendingRegistrations > 0}
              note={
                data.pendingRegistrations > 0
                  ? "voters cannot be grouped until reviewed"
                  : "queue is clear"
              }
            />
            <Stat
              label="Approved voters"
              value={data.approvedVoters.toLocaleString()}
              note={`across ${data.elections.length} election${
                data.elections.length === 1 ? "" : "s"
              }`}
            />
            <Stat
              label="Anonymity groups"
              value={data.anonymityGroups.toLocaleString()}
              note="a ballot is signed on behalf of a whole group"
            />
            <Stat
              label="Ledger"
              value={data.ledger ? data.ledger.reachable : "—"}
              suffix={data.ledger ? ` of ${data.ledger.nodes} nodes` : undefined}
              note={
                data.ledger
                  ? `height ${data.ledger.height.toLocaleString()}`
                  : "ledger did not respond"
              }
            />
          </StatStrip>

          <div className="px-7 py-6">
            <SectionRule>Needs you today</SectionRule>

            {data.attention.length === 0 ? (
              <Empty>
                Nothing is waiting on you. New registrations and elections ready to advance will
                appear here.
              </Empty>
            ) : (
              <div
                className={`grid border-2 border-ink/40 mb-8 [&>*]:border-b [&>*]:border-ink/40 [&>*:last-child]:border-b-0 ${
                  // A single item spans the full width; a second column would render as an empty
                  // bordered box beside it.
                  data.attention.length > 1
                    ? "md:grid-cols-2 md:[&>*:nth-last-child(-n+2)]:border-b-0 md:[&>*:nth-child(odd)]:border-r md:[&>*:nth-child(odd)]:border-ink/40"
                    : ""
                }`}
              >
                {data.attention.map((item) => (
                  <div key={item.key} className="flex gap-3.5 px-5 py-4">
                    <div
                      aria-hidden
                      className={`w-1 flex-none ${
                        item.severity === "action" ? "bg-accent" : "bg-neutral-500"
                      }`}
                    />
                    <div>
                      <div className="font-extrabold text-[15px] mb-1">{item.title}</div>
                      <p className="text-[12.5px] text-ink/55 m-0 mb-2.5">{item.detail}</p>
                      <Link
                        to={item.href}
                        className={`${
                          item.severity === "action" ? btn : btnSecondary
                        } no-underline text-[13px]`}
                      >
                        {item.actionLabel}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <SectionRule
              action={
                <Link to="/admin/elections" className="text-[12.5px]">
                  All elections
                </Link>
              }
            >
              Elections
            </SectionRule>

            {data.elections.length === 0 ? (
              <Empty>
                No elections yet.{" "}
                <Link to="/admin/elections/new">Create the first one</Link> to open registration.
              </Empty>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className={table}>
                  <thead>
                    <tr>
                      <th className={`${th} w-[28%]`}>Election</th>
                      <th className={th}>Stage</th>
                      <th className={th}>Voters</th>
                      <th className={th}>Groups</th>
                      <th className={th}>Ballot access</th>
                      <th className={th}>Voting closes</th>
                      <th className={th}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.elections.map((entry) => (
                      <tr key={entry.election.id} className="hover:bg-ink/4">
                        <td className={td}>
                          <div className="font-semibold">{entry.election.title}</div>
                          <div className="text-[11.5px] text-ink/55">
                            {entry.counts.candidates === 0
                              ? "no candidates yet"
                              : `${entry.counts.candidates} candidates`}
                          </div>
                        </td>
                        <td className={td}>
                          <Tag tone={toneFor(entry.election.status)}>
                            {STATUS_LABELS[entry.election.status]}
                          </Tag>
                        </td>
                        <td className={`${td} tabular-nums`}>
                          {entry.counts.eligibleVoters === 0
                            ? "—"
                            : entry.counts.eligibleVoters.toLocaleString()}
                        </td>
                        <td className={`${td} tabular-nums`}>{groupsCell(entry)}</td>
                        <td className={`${td} tabular-nums`}>{accessCell(entry)}</td>
                        <td className={td}>{formatWhen(entry.election.votingClosesAt)}</td>
                        <td className={td}>
                          <Link
                            to={`/admin/elections/${entry.election.id}`}
                            className="text-[12.5px]"
                          >
                            Open
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mt-5 text-[11.5px] text-ink/55 max-w-[86ch]">
              <Label as="span" className="inline">Note</Label> Turnout figures count ballots collected,
              not ballots cast for anyone in particular. This server records that a voter
              collected a ballot — the same fact a paper roll book records when a voter signs in
              — and never what was on it.
            </p>
          </div>
        </>
      )}
    </>
  );
}
