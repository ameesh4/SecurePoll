import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { fetchAudit, fetchElections } from "../../api/endpoints";
import { Alert, Empty, Label, PageHeader, Tag } from "../../components/primitives";
import { Pagination } from "../../components/Seg";
import { useAsyncData } from "../../hooks/useAsyncData";
import { btn, btnSecondary, input, mono, table, td, th } from "../../ui/classes";

const PAGE_SIZE = 25;

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load the audit record.";
}

/** Turns "rings.published" into "Published anonymity groups". */
const ACTION_LABELS: Record<string, string> = {
  "registration.approved": "Approved registration",
  "registration.rejected": "Rejected registration",
  "admin.logged_in": "Signed in",
  "election.created": "Created election",
  "election.updated": "Changed election details",
  "election.transitioned": "Changed lifecycle stage",
  "candidate.added": "Added candidate",
  "candidate.updated": "Changed candidate",
  "candidate.removed": "Removed candidate",
  "eligibility.granted": "Added voter to the roll",
  "eligibility.revoked": "Removed voter from the roll",
  "rings.formed": "Formed anonymity groups",
  "rings.published": "Froze & published anonymity groups",
  "tokens.issued": "Issued ballot access",
  "token.resent": "Re-sent ballot access",
  "token.recipient_changed": "Changed delivery address",
};

/** Irreversible actions are highlighted — they are what an auditor scans the record for. */
const HIGHLIGHTED = new Set([
  "rings.published",
  "election.transitioned",
]);

/**
 * Renders a before/after pair as one short line.
 *
 * The snapshots are arbitrary JSON, so this reduces them to the keys that actually changed
 * rather than dumping both objects — an audit row that requires reading two JSON blobs to
 * understand is an audit row nobody reads.
 */
function describeChange(before: unknown, after: unknown): string {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  /**
   * Snapshots are arbitrary JSON, so a nested value has to be rendered rather than coerced —
   * `String({ smallest: 11 })` is "[object Object]", which tells an auditor nothing.
   */
  const show = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (Array.isArray(value)) return `${value.length} items`;
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return "—";
      return entries.map(([key, inner]) => `${key} ${String(inner)}`).join(", ");
    }
    return String(value);
  };

  const from = asRecord(before);
  const to = asRecord(after);

  if (!from && !to) return "—";
  if (!from && to) {
    const summary = Object.entries(to)
      .filter(([, value]) => value !== null && value !== undefined)
      .slice(0, 3)
      .map(([key, value]) => `${key} ${show(value)}`)
      .join(" · ");
    return summary ? `— → ${summary}` : "created";
  }
  if (from && !to) return "removed";

  const changed = Object.keys({ ...from, ...to }).filter(
    (key) => JSON.stringify(from?.[key]) !== JSON.stringify(to?.[key]),
  );
  if (changed.length === 0) return "no change";

  return changed
    .slice(0, 2)
    .map((key) => `${key}: ${show(from?.[key])} → ${show(to?.[key])}`)
    .join(" · ");
}

export default function AuditPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? "1");
  const electionId = params.get("electionId") ?? "";
  const action = params.get("action") ?? "";

  const [actionInput, setActionInput] = useState(action);

  const loadElections = useCallback((signal: AbortSignal) => fetchElections(signal), []);
  const elections = useAsyncData(loadElections, () => "");

  const load = useCallback(
    (signal: AbortSignal) =>
      fetchAudit(
        {
          electionId: electionId || undefined,
          action: action || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
        signal,
      ),
    [electionId, action, page],
  );
  const { data, error, loading } = useAsyncData(load, toMessage);

  function update(mutate: (next: URLSearchParams) => void) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      mutate(next);
      return next;
    });
  }

  return (
    <>
      <PageHeader
        kicker={
          data ? `Append-only · ${data.totalEntries?.toLocaleString() ?? "—"} entries` : "Append-only"
        }
        title="Audit record"
      />

      <div className="flex flex-wrap gap-2.5 px-7 py-4 border-b-2 border-ink/40">
        <select
          className={`${input} max-w-[280px]`}
          value={electionId}
          onChange={(event) =>
            update((next) => {
              if (event.target.value) next.set("electionId", event.target.value);
              else next.delete("electionId");
              next.delete("page");
            })
          }
        >
          <option value="">Every election</option>
          {(elections.data?.items ?? []).map((entry) => (
            <option key={entry.election.id} value={entry.election.id}>
              {entry.election.title}
            </option>
          ))}
        </select>

        <input
          className={`${input} w-[200px]`}
          placeholder="Action contains…"
          value={actionInput}
          onChange={(event) => setActionInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            update((next) => {
              if (actionInput) next.set("action", actionInput);
              else next.delete("action");
              next.delete("page");
            });
          }}
        />

        <button
          type="button"
          className={btn}
          onClick={() =>
            update((next) => {
              if (actionInput) next.set("action", actionInput);
              else next.delete("action");
              next.delete("page");
            })
          }
        >
          Apply
        </button>

        {electionId || action ? (
          <button
            type="button"
            className={btnSecondary}
            onClick={() => {
              setActionInput("");
              setParams(new URLSearchParams());
            }}
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="px-7 py-6">
        {error ? <Alert title="Could not load">{error}</Alert> : null}
        {loading && !data ? <p className="text-[13px] text-ink/55">Loading…</p> : null}

        {data && data.items.length === 0 ? (
          <Empty>Nothing recorded for this filter.</Empty>
        ) : null}

        {data && data.items.length > 0 ? (
          <>
            <div className="w-full overflow-x-auto">
              <table className={table}>
                <thead>
                  <tr>
                    <th className={`${th} w-[150px]`}>When</th>
                    <th className={`${th} w-[150px]`}>Admin</th>
                    <th className={th}>Action</th>
                    <th className={th}>Target</th>
                    <th className={th}>Before → after</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => {
                    const highlight = HIGHLIGHTED.has(row.entry.action);
                    return (
                      <tr
                        key={row.entry.id}
                        className={highlight ? "bg-accent-100" : "hover:bg-ink/4"}
                      >
                        <td className={`${td} ${mono} text-[11.5px] whitespace-nowrap`}>
                          {new Date(row.entry.createdAt).toLocaleString("en-GB", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </td>
                        <td className={td}>
                          {row.actor ? (
                            <span className="flex flex-wrap items-center gap-1.5">
                              {row.actor.name}
                              <Tag tone={row.actor.role === "SUPER_ADMIN" ? "accent" : "neutral"}>
                                {row.actor.role === "SUPER_ADMIN" ? "Super" : "Rev"}
                              </Tag>
                            </span>
                          ) : (
                            <span className="text-ink/55">system</span>
                          )}
                        </td>
                        <td className={td}>
                          <span
                            className={`font-semibold ${highlight ? "text-accent-700" : ""}`}
                          >
                            {ACTION_LABELS[row.entry.action] ?? row.entry.action}
                          </span>
                        </td>
                        <td className={`${td} text-[12px]`}>
                          {row.entry.entityType}
                          {row.entry.entityId ? (
                            <span className={`${mono} text-ink/55`}>
                              {" "}
                              {row.entry.entityId.slice(0, 8)}
                            </span>
                          ) : null}
                        </td>
                        <td className={`${td} text-[12px] text-ink/55`}>
                          {describeChange(row.entry.before, row.entry.after)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              pageSize={PAGE_SIZE}
              onPage={(next) => update((current) => current.set("page", String(next)))}
            />

            <p className="mt-5 text-[11.5px] text-ink/55 max-w-[92ch]">
              <Label as="span" className="inline">Append-only</Label> Entries cannot be edited or deleted.
              There is no endpoint that would do it and no repository function to build one from —
              an audit table the application can rewrite is not an audit table.
            </p>
          </>
        ) : null}
      </div>
    </>
  );
}
