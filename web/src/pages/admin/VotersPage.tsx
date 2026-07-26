import { useCallback, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import {
  fetchAvailableVoters,
  fetchElection,
  fetchElectorate,
  removeVotersFromRoll,
  transferVotersOntoRoll,
} from "../../api/endpoints";
import { Pagination, Seg } from "../../components/Seg";
import {
  Alert,
  Empty,
  Label,
  PageHeader,
  SelectCheckbox,
  Stat,
  StatStrip,
  Tag,
} from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useSelection } from "../../hooks/useSelection";
import { btn, btnSecondary, input, mono, table, td, th } from "../../ui/classes";

const PAGE_SIZE = 25;

type Pane = "AVAILABLE" | "ON_ROLL";

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load voters.";
}

/**
 * The electoral roll for one election, and the pool of past voters who can be added to it.
 *
 * This screen exists because of how the system splits identity from entitlement. A person
 * registers once and is vetted once by a human, which mints their `voters` record. Whether they
 * may vote in a *particular* election is a separate decision. So the electorate for this year's
 * election is not a fresh set of registrations — it is mostly the same people as last year's, and
 * re-vetting them would be asking reviewers to redo work they have already done.
 *
 * What is being skipped is the identity check, which already happened. The decision to
 * enfranchise is not skipped: it is exactly what this screen records, once per voter, in the
 * audit log.
 */
export default function VotersPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const pane = (params.get("pane") as Pane | null) ?? "AVAILABLE";
  const page = Number(params.get("page") ?? "1");
  const search = params.get("search") ?? "";

  const [searchInput, setSearchInput] = useState(search);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadElection = useCallback((signal: AbortSignal) => fetchElection(id, signal), [id]);
  const election = useAsyncData(loadElection, toMessage);

  const loadAvailable = useCallback(
    (signal: AbortSignal) =>
      pane === "AVAILABLE"
        ? fetchAvailableVoters(
            id,
            { search: search || undefined, page, pageSize: PAGE_SIZE },
            signal,
          )
        : Promise.resolve(null),
    [id, pane, search, page],
  );
  const available = useAsyncData(loadAvailable, toMessage);

  const loadRoll = useCallback(
    (signal: AbortSignal) =>
      pane === "ON_ROLL"
        ? fetchElectorate(
            id,
            { search: search || undefined, page, pageSize: PAGE_SIZE },
            signal,
          )
        : Promise.resolve(null),
    [id, pane, search, page],
  );
  const roll = useAsyncData(loadRoll, toMessage);

  const canEnrol = election.data?.operations.reviewVoters ?? false;
  const ringsExist = (election.data?.counts.rings ?? 0) > 0;

  // Memoised because `?? []` mints a fresh array each render, which would defeat the
  // selectable-id memo below and give `useSelection` a new array identity every time.
  const availableRows = useMemo(() => available.data?.items ?? [], [available.data]);
  const rollRows = useMemo(() => roll.data?.items ?? [], [roll.data]);

  // Anyone already placed in a ring cannot be removed — the ring names their key, so removing
  // them from the roll would only make the roll disagree with the ledger.
  const selectableIds = useMemo(
    () =>
      pane === "AVAILABLE"
        ? availableRows.map((row) => row.voter.id)
        : rollRows.filter((row) => row.ringIndex === null).map((row) => row.voter.id),
    [pane, availableRows, rollRows],
  );

  const view = `${pane}|${page}|${search}`;
  const selection = useSelection(view, selectableIds);

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
      available.reload();
      roll.reload();
      election.reload();
      selection.clear();
    } catch (caught) {
      setNotice(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const activePage = pane === "AVAILABLE" ? available.data : roll.data;
  const title = election.data?.election.title ?? "Election";
  const lockedOnPage =
    pane === "ON_ROLL" ? rollRows.filter((row) => row.ringIndex !== null).length : 0;

  return (
    <>
      <PageHeader
        kicker={title}
        title="Electoral roll"
        actions={
          <>
            <Link to={`/admin/elections/${id}`} className={`${btnSecondary} no-underline`}>
              Back to election
            </Link>
            <input
              className={`${input} w-[200px]`}
              placeholder="Search name, ID or email"
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

      <StatStrip>
        <Stat
          label="On this roll"
          value={(election.data?.counts.eligibleVoters ?? 0).toLocaleString()}
          note={canEnrol ? "can still be changed" : "fixed — registration has closed"}
        />
        <Stat
          label="Anonymity groups"
          value={election.data?.counts.rings ?? 0}
          note={ringsExist ? "membership is set" : "not formed yet"}
        />
        <Stat
          label="Group size target"
          value={election.data?.election.ringSize ?? 10}
          note="minimum 10 per group"
        />
      </StatStrip>

      <div className="flex flex-wrap items-center gap-3 px-7 py-3 border-b-2 border-ink/40">
        <Seg
          name="voters-pane"
          value={pane}
          onChange={(next) =>
            update((current) => {
              current.set("pane", next);
              current.delete("page");
            })
          }
          options={[
            { value: "AVAILABLE", label: "Past voters", count: available.data?.total },
            { value: "ON_ROLL", label: "On this roll", count: roll.data?.total },
          ]}
        />
        <span className="text-[12px] text-ink/55">
          {pane === "AVAILABLE"
            ? "Vetted voters who are not on this roll yet."
            : "Voters entitled to vote in this election."}
        </span>
      </div>

      {!canEnrol ? (
        <div className="px-7 pt-4">
          <Alert title="The roll is closed">
            Voters can only be added or removed while registration is open. This election has moved
            past that, and its groups are formed against the roll as it stands — adding somebody now
            would give them a key that no published group contains, so their ballot could never be
            counted.
          </Alert>
        </div>
      ) : null}

      {notice ? (
        <div className="px-7 pt-4">
          <Alert>{notice}</Alert>
        </div>
      ) : null}
      {available.error || roll.error ? (
        <div className="px-7 pt-4">
          <Alert title="Could not load">{available.error ?? roll.error}</Alert>
        </div>
      ) : null}

      {selection.count > 0 ? (
        <div className="flex flex-wrap items-center gap-3.5 px-7 py-3 bg-accent-100 border-y-2 border-ink/40 sticky top-0 z-10">
          <span className="font-extrabold text-[13px]">{selection.count} selected</span>
          <span className="text-[12px] text-ink/60">
            {pane === "AVAILABLE"
              ? "already vetted — this records the decision to enfranchise them"
              : "removing is only possible before groups are formed"}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" className={btnSecondary} onClick={selection.clear}>
              Clear
            </button>
            {pane === "AVAILABLE" ? (
              <button
                type="button"
                className={btn}
                disabled={busy || !canEnrol}
                onClick={() =>
                  void run(async () => {
                    const outcome = await transferVotersOntoRoll(id, [...selection.ids]);
                    const already =
                      outcome.alreadyOnRoll.length > 0
                        ? ` ${outcome.alreadyOnRoll.length} were already on the roll.`
                        : "";
                    return `Added ${outcome.added.length} voters to the roll.${already}`;
                  })
                }
              >
                Add {selection.count} to the roll
              </button>
            ) : (
              <button
                type="button"
                className={btnSecondary}
                disabled={busy || !canEnrol}
                onClick={() =>
                  void run(async () => {
                    const outcome = await removeVotersFromRoll(id, [...selection.ids]);
                    const refused =
                      outcome.lockedIntoRings.length > 0
                        ? ` ${outcome.lockedIntoRings.length} could not be removed — already in a group.`
                        : "";
                    return `Removed ${outcome.removed.length} voters from the roll.${refused}`;
                  })
                }
              >
                Remove {selection.count} from the roll
              </button>
            )}
          </div>
        </div>
      ) : null}

      <div className="px-7 py-6">
        {pane === "AVAILABLE" && availableRows.length === 0 && !available.loading ? (
          <Empty>
            {search
              ? "No vetted voter outside this roll matches that search."
              : "Every vetted voter is already on this roll. New voters appear here once they have been approved in the verification queue."}
          </Empty>
        ) : null}

        {pane === "ON_ROLL" && rollRows.length === 0 && !roll.loading ? (
          <Empty>
            Nobody is on this roll yet. Add past voters from the other tab, or approve new
            registrations in the{" "}
            <Link to={`/admin/registrations?election=${id}`}>verification queue</Link>.
          </Empty>
        ) : null}

        {(pane === "AVAILABLE" ? availableRows.length : rollRows.length) > 0 ? (
          <>
            <div className="w-full overflow-x-auto">
              <table className={table}>
                <thead>
                  <tr>
                    <th className={`${th} w-[34px]`}>
                      <SelectCheckbox
                        checked={selection.allSelected}
                        disabled={selectableIds.length === 0 || !canEnrol}
                        disabledReason={
                          canEnrol
                            ? "Nothing on this page can be selected"
                            : "The roll is closed for this election"
                        }
                        onToggle={selection.toggleAll}
                        label="Select every voter on this page"
                      />
                    </th>
                    <th className={th}>Voter</th>
                    <th className={th}>National ID</th>
                    <th className={th}>Email</th>
                    {pane === "AVAILABLE" ? (
                      <th className={th}>Past elections</th>
                    ) : (
                      <th className={th}>Group</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {pane === "AVAILABLE"
                    ? availableRows.map((row) => (
                        <tr key={row.voter.id} className="hover:bg-ink/4">
                          <td className={td}>
                            <SelectCheckbox
                              checked={selection.has(row.voter.id)}
                              disabled={!canEnrol}
                              disabledReason="The roll is closed for this election"
                              onToggle={(shiftKey) => selection.toggle(row.voter.id, shiftKey)}
                              label={`Select ${row.voter.fullName}`}
                            />
                          </td>
                          <td className={`${td} font-semibold`}>{row.voter.fullName}</td>
                          <td className={`${td} ${mono}`}>{row.voter.nationalId}</td>
                          <td className={`${td} ${mono} text-[11.5px]`}>{row.voter.email}</td>
                          <td className={`${td} tabular-nums`}>
                            {row.pastElections === 0 ? (
                              <span className="text-ink/55">new voter</span>
                            ) : (
                              `${row.pastElections} election${row.pastElections === 1 ? "" : "s"}`
                            )}
                          </td>
                        </tr>
                      ))
                    : rollRows.map((row) => {
                        const locked = row.ringIndex !== null;
                        return (
                          <tr key={row.voter.id} className="hover:bg-ink/4">
                            <td className={td}>
                              <SelectCheckbox
                                checked={selection.has(row.voter.id)}
                                disabled={locked || !canEnrol}
                                disabledReason={
                                  locked
                                    ? "Already in an anonymity group — enrolment can no longer be undone"
                                    : "The roll is closed for this election"
                                }
                                onToggle={(shiftKey) => selection.toggle(row.voter.id, shiftKey)}
                                label={`Select ${row.voter.fullName}`}
                              />
                            </td>
                            <td className={`${td} font-semibold`}>{row.voter.fullName}</td>
                            <td className={`${td} ${mono}`}>{row.voter.nationalId}</td>
                            <td className={`${td} ${mono} text-[11.5px]`}>{row.voter.email}</td>
                            <td className={td}>
                              {locked ? (
                                <Tag>G-{String((row.ringIndex ?? 0) + 1).padStart(3, "0")}</Tag>
                              ) : (
                                <span className="text-[12px] text-ink/55">not grouped yet</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            </div>

            {lockedOnPage > 0 ? (
              <p className="text-[11.5px] text-ink/55 mt-3">
                {lockedOnPage} voter{lockedOnPage === 1 ? "" : "s"} on this page{" "}
                {lockedOnPage === 1 ? "is" : "are"} already in an anonymity group and cannot be
                removed. The group published to the ledger names their key; taking them off the roll
                would not un-publish it.
              </p>
            ) : null}

            {activePage ? (
              <Pagination
                page={activePage.page}
                totalPages={activePage.totalPages}
                total={activePage.total}
                pageSize={PAGE_SIZE}
                onPage={(next) => update((current) => current.set("page", String(next)))}
                hint={selectableIds.length > 1 ? "Shift-click to select a range" : undefined}
              />
            ) : null}
          </>
        ) : null}

        <p className="mt-6 text-[11.5px] text-ink/55 max-w-[92ch]">
          <Label as="span" className="inline">
            Note
          </Label>{" "}
          Everyone listed here has already been vetted by a person and has a voter record. Adding
          them to a roll records a fresh decision to enfranchise them for this election — one audit
          entry per voter — and does not re-open their identity check.
        </p>
      </div>
    </>
  );
}
