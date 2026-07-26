import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { fetchCandidates, fetchMonitoring } from "../../api/endpoints";
import { STATUS_LABELS } from "../../components/lifecycle";
import {
  Alert,
  Empty,
  Label,
  PageHeader,
  SectionRule,
  Tag,
} from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import { btnSecondary, mono } from "../../ui/classes";

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load monitoring.";
}

/**
 * Screen 1j. Turnout while voting is open, and no ballot data anywhere.
 *
 * The result panel stays empty until voting closes, and that is not a permissions decision that
 * could be relaxed later: this server holds no ballots, so there is nothing here to count. When
 * the panel does fill, the numbers are read from the ledger on each request and never written to
 * this database — a stored copy could disagree with the ledger, and the ledger is the record.
 */
export default function MonitoringPage() {
  const { id = "" } = useParams();

  const load = useCallback((signal: AbortSignal) => fetchMonitoring(id, signal), [id]);
  const { data, error, loading, reload } = useAsyncData(load, toMessage);

  const loadCandidates = useCallback(
    (signal: AbortSignal) => fetchCandidates(id, signal),
    [id],
  );
  const candidates = useAsyncData(loadCandidates, () => "");

  const nameById = new Map<string, { name: string; office: string }>();
  for (const group of candidates.data?.offices ?? []) {
    for (const candidate of group.candidates) {
      nameById.set(candidate.id, { name: candidate.name, office: candidate.office });
    }
  }

  if (!data) {
    return (
      <div className="p-7">
        {error ? <Alert title="Could not load">{error}</Alert> : null}
        {loading ? <p className="text-[13px] text-ink/55">Loading…</p> : null}
      </div>
    );
  }

  const { election, counts, rings, ledger, rejectedSubmissions, tally } = data;
  const issued = counts.tokensIssued;
  const collected = counts.tokensRedeemed;
  const turnout = issued === 0 ? 0 : (collected / issued) * 100;
  const uncollected = issued - collected;

  const tallyRows = tally
    ? Object.entries(tally)
        .map(([candidateId, votes]) => ({
          candidateId,
          votes,
          ...(nameById.get(candidateId) ?? { name: candidateId, office: "Unknown office" }),
        }))
        .sort((a, b) => b.votes - a.votes)
    : [];
  const highest = tallyRows[0]?.votes ?? 0;

  return (
    <>
      <PageHeader
        kicker={election.title}
        title="Monitoring"
        meta={
          <Tag tone={election.status === "VOTING_OPEN" ? "outline" : "neutral"}>
            {STATUS_LABELS[election.status]}
          </Tag>
        }
        actions={
          <>
            <Link to={`/admin/elections/${id}`} className={`${btnSecondary} no-underline`}>
              Back to election
            </Link>
            <button type="button" className={btnSecondary} onClick={reload}>
              Refresh
            </button>
          </>
        }
      />

      <div className="grid lg:grid-cols-[1fr_360px]">
        <div className="px-7 py-6 border-b-2 lg:border-b-0 lg:border-r-2 border-ink/40">
          <SectionRule>Turnout</SectionRule>

          <div className="flex flex-wrap items-end gap-4 mt-2.5 mb-1.5">
            <div className="font-extrabold text-[84px] leading-[0.9] tracking-[-0.03em] tabular-nums">
              {turnout.toFixed(1)}
              <span className="text-[36px]">%</span>
            </div>
            <div className="pb-2.5">
              <div className="text-[13.5px] font-semibold">
                {collected.toLocaleString()} of {issued.toLocaleString()} ballots collected
              </div>
              <div className="text-[12.5px] text-ink/55">
                {uncollected.toLocaleString()} link{uncollected === 1 ? "" : "s"} not yet used
              </div>
            </div>
          </div>

          <div
            className="flex h-4 border border-ink/40 mb-7"
            role="img"
            aria-label={`Turnout ${turnout.toFixed(1)} percent`}
          >
            <div className="bg-accent" style={{ width: `${turnout}%` }} />
          </div>

          <SectionRule>Result · available after voting closes</SectionRule>

          {tally === null ? (
            <div className="border-2 border-dashed border-ink/40 p-6 flex flex-wrap gap-4 items-center">
              <div className="font-extrabold text-[15px] max-w-[24em]">
                The tally is read from the ledger, not from this server.
              </div>
              <p className="text-[12.5px] text-ink/55 m-0 max-w-[38em]">
                No counts exist here while voting is open — the verification server never receives
                a ballot. When voting closes, this panel fills with per-candidate totals pulled
                from the ledger.
              </p>
            </div>
          ) : tallyRows.length === 0 ? (
            <Empty>The ledger returned no totals for this election.</Empty>
          ) : (
            <div className="flex flex-col gap-2.5">
              {tallyRows.map((row) => (
                <div key={row.candidateId}>
                  <div className="flex justify-between items-baseline text-[13px] mb-1">
                    <span>
                      <strong className="font-semibold">{row.name}</strong>{" "}
                      <span className="text-ink/55">· {row.office}</span>
                    </span>
                    <span className="font-extrabold tabular-nums">
                      {row.votes.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-3 bg-neutral-200">
                    <div
                      className="h-full bg-ink"
                      style={{ width: highest === 0 ? "0%" : `${(row.votes / highest) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
              <p className="text-[11.5px] text-ink/55 mt-2">
                Read from the ledger on this request. Nothing here is stored in this server's
                database — a saved copy could drift from the ledger, and the ledger is the record.
              </p>
            </div>
          )}
        </div>

        <div className="px-6 py-6">
          <Label className="mb-3">Ledger</Label>
          <div className="border-2 border-ink/40 mb-5">
            {[
              {
                label: "Nodes reachable",
                value: ledger ? `${ledger.reachable} of ${ledger.nodes}` : "no response",
              },
              {
                label: "Height",
                value: ledger ? (
                  <span className={mono}>{ledger.height.toLocaleString()}</span>
                ) : (
                  "—"
                ),
              },
              {
                label: "Groups published",
                value: `${rings.published} of ${rings.total}`,
              },
              {
                label: "Rejected submissions",
                value:
                  rejectedSubmissions === null ? "—" : rejectedSubmissions.toLocaleString(),
                accent: (rejectedSubmissions ?? 0) > 0,
              },
            ].map((row, index, all) => (
              <div
                key={row.label}
                className={`flex justify-between gap-2 px-3.5 py-3 text-[13px] ${
                  index < all.length - 1 ? "border-b border-ink/40" : ""
                }`}
              >
                <span className="text-ink/55">{row.label}</span>
                <span className={`font-semibold ${row.accent ? "text-accent-700" : ""}`}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>

          <Label className="mb-2.5">Rejected submissions</Label>
          <p className="text-[12.5px] text-ink/55">
            Ballots the ledger refused: either a repeat attempt by someone who had already voted,
            or a signature that failed its check. Neither case identifies a voter, and no ballot
            content is visible — the count is all there is to see, by construction.
          </p>

          <div className="h-0.5 bg-ink/40 my-5" />

          <Label className="mb-2.5">
            {election.status === "VOTING_OPEN" ? "Closing voting" : "Voting has closed"}
          </Label>
          <ul className="list-disc text-[12.5px] leading-relaxed pl-4.5 m-0">
            <li>Ballot-access links stop working immediately.</li>
            <li>
              Uncollected access ({uncollected.toLocaleString()}) expires unused.
            </li>
            <li>The tally becomes readable from the ledger.</li>
            <li>It cannot be reopened.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
