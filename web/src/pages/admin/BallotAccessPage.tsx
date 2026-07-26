import { useCallback, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import {
  changeBallotRecipient,
  dispatchBallotAccess,
  fetchBallotAccess,
  fetchElection,
  issueBallotAccess,
  resendBallotAccess,
  retryBallotAccess,
} from "../../api/endpoints";
import type { BallotAccessRow, EmailDeliveryStatus } from "../../api/types";
import { Pagination, Seg } from "../../components/Seg";
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
import { btn, btnGhost, btnSecondary, input, mono, table, td, th } from "../../ui/classes";

const PAGE_SIZE = 25;

type Filter = "ALL" | EmailDeliveryStatus;

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load ballot access.";
}

function formatWhen(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(status: EmailDeliveryStatus) {
  if (status === "FAILED") return "accent" as const;
  if (status === "SENT") return "neutral" as const;
  return "neutral" as const;
}

/**
 * Screen 1h. Batched dispatch with a per-recipient state, because sending thousands of emails
 * inside one request would hold the admin's connection open for minutes and lose the whole batch
 * on a timeout.
 *
 * Note what the table does not have a column for. "Access used" records that a voter collected
 * a ballot — the same fact a paper roll book records when someone signs in — and there is no
 * field anywhere for what was on it. Not because it is hidden here, but because this server never
 * receives it.
 */
export default function BallotAccessPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("status") as Filter | null) ?? "ALL";
  const page = Number(params.get("page") ?? "1");
  const search = params.get("search") ?? "";

  const [searchInput, setSearchInput] = useState(search);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingRecipient, setEditingRecipient] = useState<BallotAccessRow | null>(null);
  const [newEmail, setNewEmail] = useState("");

  const loadElection = useCallback((signal: AbortSignal) => fetchElection(id, signal), [id]);
  const election = useAsyncData(loadElection, toMessage);

  const loadAccess = useCallback(
    (signal: AbortSignal) =>
      fetchBallotAccess(
        id,
        {
          status: filter === "ALL" ? undefined : filter,
          search: search || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
        signal,
      ),
    [id, filter, search, page],
  );
  const access = useAsyncData(loadAccess, toMessage);

  const canIssue = election.data?.operations.issueTokens ?? false;
  const data = access.data;
  const summary = data?.summary;
  const remaining = (election.data?.counts.eligibleVoters ?? 0) - (summary?.total ?? 0);

  function update(mutate: (next: URLSearchParams) => void) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      mutate(next);
      return next;
    });
  }

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
      access.reload();
      election.reload();
    } catch (caught) {
      setNotice(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const total = summary?.total ?? 0;
  const percent = (value: number) => (total === 0 ? 0 : (value / total) * 100);

  return (
    <>
      <PageHeader
        kicker={election.data?.election.title ?? "Election"}
        title="Ballot access"
        actions={
          <>
            <Link to={`/admin/elections/${id}`} className={`${btnSecondary} no-underline`}>
              Back to election
            </Link>
            {summary && summary.failed > 0 ? (
              <button
                type="button"
                className={btnSecondary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const outcome = await retryBallotAccess(id);
                    return `Re-sent ${outcome.requeued} failed links.`;
                  })
                }
              >
                Retry {summary.failed} failed
              </button>
            ) : null}
            {summary && summary.pending > 0 ? (
              <button
                type="button"
                className={btnSecondary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const outcome = await dispatchBallotAccess(id);
                    return `Attempted delivery to ${outcome.attempted} recipients.`;
                  })
                }
              >
                Send {summary.pending} pending
              </button>
            ) : null}
            {canIssue ? (
              <button
                type="button"
                className={btn}
                disabled={busy || remaining <= 0}
                title={
                  remaining <= 0 ? "Every approved voter already holds a link" : undefined
                }
                onClick={() =>
                  void run(async () => {
                    const outcome = await issueBallotAccess(id);
                    return outcome.issued === 0
                      ? "Every approved voter already holds a link."
                      : `Issued ${outcome.issued} links and queued them for delivery.`;
                  })
                }
              >
                {remaining > 0 ? `Send to ${remaining} remaining` : "All issued"}
              </button>
            ) : null}
          </>
        }
      />

      {notice ? (
        <div className="px-7 pt-4">
          <Alert>{notice}</Alert>
        </div>
      ) : null}
      {access.error ? (
        <div className="px-7 pt-4">
          <Alert title="Could not load">{access.error}</Alert>
        </div>
      ) : null}

      {summary && total > 0 ? (
        <div className="px-7 py-5 border-b-2 border-ink/40">
          <div className="flex flex-wrap justify-between items-baseline gap-2 mb-2.5">
            <Label>Dispatch · {total.toLocaleString()} recipients</Label>
            <span className="font-extrabold text-[14px] tabular-nums">
              {percent(summary.sent).toFixed(1)}% delivered
            </span>
          </div>
          <div
            className="flex h-[22px] border border-ink/40"
            role="img"
            aria-label={`Sent ${summary.sent}, pending ${summary.pending}, failed ${summary.failed}, bounced ${summary.bounced}`}
          >
            <div className="bg-ink" style={{ width: `${percent(summary.sent)}%` }} />
            <div
              className="bg-neutral-500"
              style={{ width: `${percent(summary.pending)}%` }}
            />
            <div className="bg-accent" style={{ width: `${percent(summary.failed)}%` }} />
            <div
              className="bg-neutral-300"
              style={{ width: `${percent(summary.bounced)}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-6 mt-2.5 text-[12.5px]">
            {[
              { label: "Sent", value: summary.sent, colour: "bg-ink" },
              { label: "Pending", value: summary.pending, colour: "bg-neutral-500" },
              { label: "Failed", value: summary.failed, colour: "bg-accent" },
              { label: "Bounced", value: summary.bounced, colour: "bg-neutral-300" },
            ].map((entry) => (
              <span key={entry.label} className="flex items-center gap-2">
                <span aria-hidden className={`w-3 h-3 ${entry.colour}`} />
                {entry.label} {entry.value.toLocaleString()}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {summary ? (
        <StatStrip>
          <Stat
            label="Access used"
            value={summary.redeemed.toLocaleString()}
            suffix={` / ${total.toLocaleString()}`}
            note={`${percent(summary.redeemed).toFixed(1)}% of voters have collected a ballot`}
          />
          <Stat
            label="Links expire"
            value={
              data?.expiresAt
                ? new Date(data.expiresAt).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "—"
            }
            note={data?.expiresAt ? formatWhen(data.expiresAt) : "no close time set"}
          />
          <Stat
            label="Resend limit"
            value={data?.resendLimit.max ?? 3}
            suffix={` / voter / ${data?.resendLimit.windowMinutes ?? 60} min`}
            note="rate-limited per recipient"
          />
        </StatStrip>
      ) : null}

      <div className="px-7 py-6">
        {total === 0 ? (
          <Empty>
            No ballot access has been issued yet.{" "}
            {canIssue
              ? "Issuing mints one single-use link per approved voter and queues it for delivery."
              : "Links can be issued once anonymity groups are published."}
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <Seg
                name="dispatch-filter"
                value={filter}
                onChange={(next) =>
                  update((current) => {
                    current.set("status", next);
                    current.delete("page");
                  })
                }
                options={[
                  { value: "ALL", label: "All", count: summary?.total },
                  { value: "FAILED", label: "Failed", count: summary?.failed },
                  { value: "BOUNCED", label: "Bounced", count: summary?.bounced },
                  { value: "PENDING", label: "Pending", count: summary?.pending },
                ]}
              />
              <input
                className={`${input} w-[200px] ml-auto`}
                placeholder="Search recipient"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  update((next) => {
                    if (searchInput) next.set("search", searchInput);
                    else next.delete("search");
                    next.delete("page");
                  });
                }}
              />
            </div>

            <div className="w-full overflow-x-auto">
              <table className={table}>
                <thead>
                  <tr>
                    <th className={th}>Voter</th>
                    <th className={th}>Email</th>
                    <th className={th}>Status</th>
                    <th className={th}>Attempts</th>
                    <th className={th}>Last attempt</th>
                    <th className={th}>Access used</th>
                    <th className={th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.items ?? []).map((row) => (
                    <tr key={row.id} className="hover:bg-ink/4">
                      <td className={`${td} font-semibold`}>{row.fullName}</td>
                      <td className={`${td} ${mono} text-[11.5px]`}>{row.deliverTo}</td>
                      <td className={td}>
                        {row.emailStatus === "SENT" ? (
                          <span className="text-[12px] text-ink/55">Sent</span>
                        ) : (
                          <Tag tone={statusTone(row.emailStatus)}>
                            {row.emailStatus.toLowerCase()}
                          </Tag>
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>{row.deliveryAttempts}</td>
                      <td className={`${td} text-[12px]`}>
                        {formatWhen(row.lastAttemptAt)}
                        {row.lastError ? (
                          <span className="text-ink/55"> · {row.lastError}</span>
                        ) : null}
                      </td>
                      <td className={td}>
                        {row.accessUsed ? (
                          <span className="text-[12px]">yes · {formatWhen(row.redeemedAt)}</span>
                        ) : (
                          <span className="text-[12px] text-ink/55">no</span>
                        )}
                      </td>
                      <td className={td}>
                        {row.accessUsed ? (
                          <span className="text-[11.5px] text-ink/45">collected</span>
                        ) : (
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              className={btnGhost}
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await resendBallotAccess(row.id);
                                  return `A new link was sent to ${row.deliverTo}. The previous one no longer works.`;
                                })
                              }
                            >
                              Resend
                            </button>
                            {row.emailStatus === "BOUNCED" ? (
                              <button
                                type="button"
                                className={btnGhost}
                                disabled={busy}
                                onClick={() => {
                                  setEditingRecipient(row);
                                  setNewEmail(row.deliverTo);
                                }}
                              >
                                Change email…
                              </button>
                            ) : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data ? (
              <Pagination
                page={data.page}
                totalPages={data.totalPages}
                total={data.total}
                pageSize={PAGE_SIZE}
                onPage={(next) => update((current) => current.set("page", String(next)))}
              />
            ) : null}

            {editingRecipient ? (
              <div className="border-2 border-ink/40 p-4 mt-5 max-w-[520px]">
                <SectionRule>Change the address for {editingRecipient.fullName}</SectionRule>
                <p className="text-[12.5px] text-ink/55 mb-2.5">
                  Only the delivery address changes. The voter's identity record is untouched, and
                  the link itself is replaced on the next send — so a link that reached the wrong
                  inbox stops working.
                </p>
                <input
                  className={`${input} ${mono}`}
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                />
                <div className="flex gap-2 mt-3">
                  <button
                    type="button"
                    className={btn}
                    disabled={busy || !newEmail.includes("@")}
                    onClick={() =>
                      void run(async () => {
                        await changeBallotRecipient(editingRecipient.id, newEmail.trim());
                        setEditingRecipient(null);
                        return "Address updated and queued for a fresh link.";
                      })
                    }
                  >
                    Save address
                  </button>
                  <button
                    type="button"
                    className={btnSecondary}
                    onClick={() => setEditingRecipient(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            <p className="mt-6 text-[11.5px] text-accent-700 max-w-[92ch]">
              This list shows delivery state and whether access was collected — never a ballot, and
              never a link between a voter and a cast vote. "Access used" is the same fact a paper
              roll book records when a voter signs in.
            </p>
          </>
        )}
      </div>
    </>
  );
}
