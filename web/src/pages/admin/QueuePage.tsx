import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import {
  approveRegistration,
  approveRegistrations,
  fetchElections,
  fetchQueue,
  fetchRegistration,
  rejectRegistration,
  rejectRegistrationsBulk,
} from "../../api/endpoints";
import type { QueueRow, RegistrationStatus } from "../../api/types";
import { Pagination, Seg } from "../../components/Seg";
import {
  Alert,
  Empty,
  Label,
  PageHeader,
  SelectCheckbox,
  Tag,
} from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useSelection } from "../../hooks/useSelection";
import { btn, btnSecondary, input, textarea } from "../../ui/classes";
import RecordPanel from "./QueueRecord";

const PAGE_SIZE = 12;

const NOT_SELECTABLE =
  "Only pending records can be selected — approve and reject are the only bulk actions here.";

type Filter = "PENDING" | "FLAGGED" | "APPROVED" | "REJECTED";

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load the review queue.";
}

function statusFor(filter: Filter): RegistrationStatus | undefined {
  return filter === "FLAGGED" ? "PENDING" : filter;
}

function waitingFor(iso: string): string {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return "waiting under an hour";
  const days = Math.floor(hours / 24);
  return days === 0 ? `waiting ${hours} h` : `waiting ${days} d ${hours % 24} h`;
}

/**
 * Screen 1c with 1d's bulk bar folded in, as the design's own "try next" suggested.
 *
 * One route rather than two: the list and the open record sit side by side, so a reviewer
 * working a long queue never loses their place in it. Bulk approve appears above the list once
 * a selection exists — and refuses itself when anything in that selection carries a duplicate
 * flag, because waving through a possible duplicate inside a batch of forty is precisely the
 * mistake that puts one person on the roll twice.
 */
export default function QueuePage() {
  const [params, setParams] = useSearchParams();
  const filter = (params.get("filter") as Filter | null) ?? "PENDING";
  const page = Number(params.get("page") ?? "1");
  const search = params.get("search") ?? "";
  const selectedId = params.get("selected");
  const electionId = params.get("election") ?? "";

  const [searchInput, setSearchInput] = useState(search);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkRejectFor, setBulkRejectFor] = useState<string | null>(null);

  const loadQueue = useCallback(
    (signal: AbortSignal) =>
      fetchQueue(
        {
          status: statusFor(filter),
          flaggedOnly: filter === "FLAGGED",
          search: search || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
        signal,
      ),
    [filter, search, page],
  );
  const queue = useAsyncData(loadQueue, toMessage);

  const loadElections = useCallback((signal: AbortSignal) => fetchElections(signal), []);
  const elections = useAsyncData(loadElections, () => "");

  const loadRecord = useCallback(
    (signal: AbortSignal) =>
      selectedId ? fetchRegistration(selectedId, signal) : Promise.resolve(null),
    [selectedId],
  );
  const record = useAsyncData(loadRecord, toMessage);

  // Memoised because `?? []` mints a fresh array on every render, which would make the
  // selectable-id memo below recompute each time and hand `useSelection` a new array identity.
  const rows = useMemo(() => queue.data?.items ?? [], [queue.data]);

  const view = `${filter}|${page}|${search}`;
  // Only a pending record can be approved or rejected, so only those are selectable here.
  const selectableIds = useMemo(
    () => rows.filter((row) => row.status === "PENDING").map((row) => row.id),
    [rows],
  );
  const selection = useSelection(view, selectableIds);
  // Tagged the same way, so the reject-reason box closes with the selection it belonged to.
  const showBulkReject = bulkRejectFor === view;

  // Only an election open for registration can be enfranchised into — the server refuses any
  // other state, so offering one would produce nothing but a 409.
  const openElections = (elections.data?.items ?? []).filter(
    (entry) => entry.election.status === "REGISTRATION_OPEN",
  );

  const firstOpenId = openElections[0]?.election.id;
  useEffect(() => {
    if (electionId || !firstOpenId) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("election", firstOpenId);
        return next;
      },
      { replace: true },
    );
  }, [electionId, firstOpenId, setParams]);

  function update(mutate: (next: URLSearchParams) => void) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      mutate(next);
      return next;
    });
  }

  const selected = rows.filter((row) => selection.has(row.id));
  const flaggedInSelection = selected.filter((row) => row.duplicateFields.length > 0);
  const canBulkApprove =
    selected.length > 0 && flaggedInSelection.length === 0 && Boolean(electionId);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
      queue.reload();
      record.reload();
      selection.clear();
    } catch (caught) {
      setNotice(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        kicker="Manual vetting"
        title="Verification queue"
        actions={
          <>
            <label className="flex items-center gap-2 text-[12.5px]">
              <span className="text-ink/55">Enfranchise into</span>
              <select
                className={`${input} max-w-[220px]`}
                value={electionId}
                onChange={(event) =>
                  update((next) => next.set("election", event.target.value))
                }
              >
                <option value="">No election</option>
                {openElections.map((entry) => (
                  <option key={entry.election.id} value={entry.election.id}>
                    {entry.election.title}
                  </option>
                ))}
              </select>
            </label>
            <input
              className={`${input} w-[190px]`}
              placeholder="Search name or ID"
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
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3 px-7 py-3 border-b-2 border-ink/40">
        <Seg
          name="queue-filter"
          value={filter}
          onChange={(next) =>
            update((current) => {
              current.set("filter", next);
              current.delete("page");
            })
          }
          options={[
            { value: "PENDING", label: "Pending", count: queue.data?.counts.PENDING },
            { value: "FLAGGED", label: "Flagged", count: queue.data?.flagged },
            { value: "APPROVED", label: "Approved", count: queue.data?.counts.APPROVED },
            { value: "REJECTED", label: "Rejected", count: queue.data?.counts.REJECTED },
          ]}
        />
        {openElections.length === 0 && !elections.loading ? (
          <span className="text-[11.5px] text-accent-700">
            No election is open for registration, so approvals cannot enfranchise anyone yet.
          </span>
        ) : null}
      </div>

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3.5 px-7 py-3 bg-accent-100 border-b-2 border-ink/40">
          <span className="font-extrabold text-[13px]">{selected.length} selected</span>
          <span className="text-[12px] text-ink/60">
            {flaggedInSelection.length === 0
              ? "all clean · no duplicate flags in selection"
              : `${flaggedInSelection.length} carry a duplicate flag — review those individually`}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" className={btnSecondary} onClick={selection.clear}>
              Clear
            </button>
            <button
              type="button"
              className={btnSecondary}
              disabled={busy}
              onClick={() => setBulkRejectFor(showBulkReject ? null : view)}
            >
              Reject with reason…
            </button>
            <button
              type="button"
              className={btn}
              disabled={!canBulkApprove || busy}
              title={
                flaggedInSelection.length > 0
                  ? "Records with a duplicate flag must be reviewed one at a time"
                  : electionId
                    ? undefined
                    : "Choose which election these voters are being enfranchised into"
              }
              onClick={() =>
                void run(async () => {
                  const outcome = await approveRegistrations(
                    selected.map((row) => row.id),
                    electionId || undefined,
                  );
                  return outcome.failed.length === 0
                    ? `Approved ${outcome.approved.length} voters.`
                    : `Approved ${outcome.approved.length}; ${outcome.failed.length} could not be approved — ${outcome.failed[0]?.reason ?? "unknown reason"}.`;
                })
              }
            >
              Approve {selected.length} voters
            </button>
          </div>

          {showBulkReject ? (
            <div className="w-full flex flex-wrap items-end gap-2 pt-2">
              <label className="flex-1 min-w-[280px]">
                <Label className="mb-1.5">Reason sent to every selected voter</Label>
                <textarea
                  className={textarea}
                  rows={2}
                  value={bulkReason}
                  onChange={(event) => setBulkReason(event.target.value)}
                  placeholder="e.g. The photograph of your student ID was unreadable."
                />
              </label>
              <button
                type="button"
                className={btn}
                disabled={bulkReason.trim().length < 3 || busy}
                onClick={() =>
                  void run(async () => {
                    const outcome = await rejectRegistrationsBulk(
                      selected.map((row) => row.id),
                      bulkReason.trim(),
                    );
                    setBulkReason("");
                    setBulkRejectFor(null);
                    return `Rejected ${outcome.rejected.length} registrations.`;
                  })
                }
              >
                Reject {selected.length}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <div className="px-7 pt-4">
          <Alert>{notice}</Alert>
        </div>
      ) : null}
      {queue.error ? (
        <div className="px-7 pt-4">
          <Alert title="Could not load">{queue.error}</Alert>
        </div>
      ) : null}

      <div className="grid lg:grid-cols-[392px_1fr] min-h-[70vh]">
        <div className="flex flex-col border-b-2 lg:border-b-0 lg:border-r-2 border-ink/40">
          <div className="flex items-center justify-between gap-2 px-4.5 py-2.5 border-b border-ink/40">
            <label className="flex items-center gap-2">
              <SelectCheckbox
                checked={selection.allSelected}
                disabled={selectableIds.length === 0}
                disabledReason={NOT_SELECTABLE}
                onToggle={selection.toggleAll}
                label="Select every pending record on this page"
              />
              <Label>Newest first</Label>
            </label>
            <span className="text-[11px] text-ink/55">
              {queue.data ? `${rows.length} of ${queue.data.total}` : "…"}
            </span>
          </div>

          {/*
            Selection only means something for pending records — approve and reject are the only
            bulk actions here, and neither applies to a record that has already been decided. Said
            out loud rather than left as greyed-out boxes, which just read as broken.
          */}
          {selectableIds.length === 0 && rows.length > 0 ? (
            <p className="px-4.5 py-2.5 text-[11.5px] text-ink/55 border-b border-ink/40 m-0">
              {NOT_SELECTABLE}{" "}
              {electionId ? (
                <Link to={`/admin/elections/${electionId}/voters`} className="text-[11.5px]">
                  Add approved voters to a roll →
                </Link>
              ) : (
                <Link to="/admin/elections" className="text-[11.5px]">
                  Add approved voters to a roll →
                </Link>
              )}
            </p>
          ) : null}

          {rows.length === 0 ? (
            <div className="p-4.5">
              <Empty>
                {filter === "FLAGGED"
                  ? "No pending record collides with an existing voter or registration. Duplicate submissions are refused at intake, so this list is normally empty."
                  : "Nothing in this view."}
              </Empty>
            </div>
          ) : (
            <ul className="list-none m-0 p-0">
              {rows.map((row: QueueRow) => {
                const active = row.id === selectedId;
                return (
                  <li
                    key={row.id}
                    className={`border-b border-ink/40 ${
                      active ? "bg-accent-100 shadow-[inset_3px_0_0_var(--color-accent)]" : ""
                    }`}
                  >
                    <div className="flex items-start gap-2.5 px-4.5 py-3.5">
                      <SelectCheckbox
                        className="mt-1"
                        checked={selection.has(row.id)}
                        disabled={row.status !== "PENDING"}
                        disabledReason={NOT_SELECTABLE}
                        onToggle={(shiftKey) => selection.toggle(row.id, shiftKey)}
                        label={`Select ${row.fullName}`}
                      />
                      <button
                        type="button"
                        className="flex-1 text-left bg-transparent border-0 p-0 cursor-pointer"
                        onClick={() => update((next) => next.set("selected", row.id))}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-sm">{row.fullName}</span>
                          {row.duplicateFields.length > 0 ? (
                            <Tag tone="accent">Duplicate?</Tag>
                          ) : row.status !== "PENDING" ? (
                            <Tag>{row.status.toLowerCase()}</Tag>
                          ) : null}
                        </span>
                        <span className="block text-[11.5px] text-ink/55 mt-0.5">
                          {row.status === "PENDING"
                            ? waitingFor(row.createdAt)
                            : `reviewed ${new Date(
                                row.reviewedAt ?? row.updatedAt,
                              ).toLocaleDateString("en-GB", {
                                day: "2-digit",
                                month: "short",
                              })}`}
                        </span>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {queue.data ? (
            <div className="mt-auto px-4.5 pb-4 border-t-2 border-ink/40">
              <Pagination
                page={queue.data.page}
                totalPages={queue.data.totalPages}
                total={queue.data.total}
                pageSize={PAGE_SIZE}
                onPage={(next) => update((current) => current.set("page", String(next)))}
              />
            </div>
          ) : null}
        </div>

        <RecordPanel
          detail={record.data}
          loading={record.loading}
          busy={busy}
          electionId={electionId || undefined}
          electionTitle={
            openElections.find((entry) => entry.election.id === electionId)?.election.title
          }
          onApprove={(id) =>
            void run(async () => {
              await approveRegistration(id, electionId || undefined);
              return "Voter approved and added to the roll.";
            })
          }
          onReject={(id, reason) =>
            void run(async () => {
              await rejectRegistration(id, reason);
              return "Registration rejected. The voter has been emailed the reason.";
            })
          }
        />
      </div>
    </>
  );
}
