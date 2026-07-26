import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import {
  createCandidate,
  deleteCandidate,
  fetchCandidates,
  fetchElection,
  reorderCandidates,
  updateCandidate,
} from "../../api/endpoints";
import type { Candidate } from "../../api/types";
import { Alert, Empty, Label, PageHeader, SectionRule } from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import { btn, btnGhost, btnSecondary, field, input, label } from "../../ui/classes";

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load candidates.";
}

const EMPTY_DRAFT = { office: "", name: "", affiliation: "", photoUrl: "" };

/**
 * Screen 1f. Ballot order is the layout: candidates appear grouped by the office they contest,
 * in the order they will appear on the ballot, because that ordering is the thing being edited.
 *
 * An office with one name is outlined in the accent, because it is not a warning about tidiness
 * — voting cannot open on an uncontested office, and once registration closes this list is
 * permanent, so it has to be fixed *now* or the election deadlocks.
 */
export default function CandidatesPage() {
  const { id = "" } = useParams();

  const loadElection = useCallback((signal: AbortSignal) => fetchElection(id, signal), [id]);
  const election = useAsyncData(loadElection, toMessage);

  const loadCandidates = useCallback(
    (signal: AbortSignal) => fetchCandidates(id, signal),
    [id],
  );
  const candidates = useAsyncData(loadCandidates, toMessage);

  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editing, setEditing] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const editable = election.data?.operations.manageCandidates ?? false;

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
      candidates.reload();
      election.reload();
    } catch (caught) {
      setNotice(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function move(office: string, list: Candidate[], index: number, delta: number) {
    const next = [...list];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    void run(async () => {
      await reorderCandidates(
        id,
        office,
        next.map((candidate) => candidate.id),
      );
      return "Ballot order updated.";
    });
  }

  const offices = candidates.data?.offices ?? [];

  return (
    <>
      <PageHeader
        kicker={election.data?.election.title ?? "Election"}
        title="Candidates"
        actions={
          <Link to={`/admin/elections/${id}`} className={`${btnSecondary} no-underline`}>
            Back to election
          </Link>
        }
      />

      <div className="px-7 py-3.5 bg-surface border-b-2 border-ink/40 flex flex-wrap gap-3 items-baseline">
        <Label accent>
          {editable ? "Editable until registration closes" : "Permanent — no longer editable"}
        </Label>
        <p className="text-[12.5px] m-0 max-w-[90ch]">
          A ballot's signature commits to a candidate's identifier, so these entries become
          permanent the moment registration closes. Correcting a spelling afterwards would be
          harmless; re-pointing an entry at a different person would silently reassign every vote
          already cast for it, and nothing in the ledger would reveal that it happened.
        </p>
      </div>

      {notice ? (
        <div className="px-7 pt-4">
          <Alert>{notice}</Alert>
        </div>
      ) : null}
      {candidates.error ? (
        <div className="px-7 pt-4">
          <Alert title="Could not load">{candidates.error}</Alert>
        </div>
      ) : null}

      <div className="px-7 py-6">
        {offices.length === 0 ? (
          <Empty>
            No candidates yet. Add at least two for every office being contested — voting cannot
            open otherwise.
          </Empty>
        ) : (
          offices.map((group) => (
            <div key={group.office} className="mb-7">
              <SectionRule accent={group.belowMinimum}>
                {group.office} · {group.candidates.length} candidate
                {group.candidates.length === 1 ? "" : "s"}
                {group.belowMinimum ? " · below minimum" : ""}
              </SectionRule>

              <div
                className={`grid sm:grid-cols-2 lg:grid-cols-3 border-2 ${
                  group.belowMinimum ? "border-accent" : "border-ink/40"
                }`}
              >
                {group.candidates.map((candidate, index) => (
                  <div
                    key={candidate.id}
                    className="flex gap-3.5 p-4 border-b border-r border-ink/40"
                  >
                    <div className="w-16 h-20 flex-none border border-dashed border-ink/40 bg-neutral-200 grid place-items-center text-[9px] text-ink/50 text-center overflow-hidden">
                      {candidate.photoUrl ? (
                        <img
                          src={candidate.photoUrl}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        "no photo"
                      )}
                    </div>
                    <div className="min-w-0">
                      <Label>Ballot {String(candidate.ballotPosition).padStart(2, "0")}</Label>
                      <div className="font-extrabold text-[15px] my-0.5">{candidate.name}</div>
                      <div className="text-[12px] text-ink/55">
                        {candidate.affiliation ?? "Independent"}
                      </div>
                      {editable ? (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          <button
                            type="button"
                            className={btnGhost}
                            disabled={busy}
                            onClick={() => setEditing(candidate)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className={btnGhost}
                            disabled={busy || index === 0}
                            onClick={() => move(group.office, group.candidates, index, -1)}
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            className={btnGhost}
                            disabled={busy || index === group.candidates.length - 1}
                            onClick={() => move(group.office, group.candidates, index, 1)}
                          >
                            Down
                          </button>
                          <button
                            type="button"
                            className={btnGhost}
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await deleteCandidate(candidate.id);
                                return `Removed ${candidate.name}.`;
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}

                {group.belowMinimum && editable ? (
                  <div className="p-4 border-b border-r border-ink/40 grid place-items-start content-center">
                    <button
                      type="button"
                      className={btn}
                      onClick={() => setDraft({ ...EMPTY_DRAFT, office: group.office })}
                    >
                      Add second candidate
                    </button>
                    <div className="text-[11.5px] text-ink/55 mt-2">
                      Voting cannot open with one candidate.
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}

        {editable ? (
          <div className="border-2 border-ink/40 p-5 max-w-[820px]">
            <SectionRule>{editing ? `Edit ${editing.name}` : "Add a candidate"}</SectionRule>
            <div className="grid md:grid-cols-2 gap-4">
              <div className={field}>
                <label className={label} htmlFor="office">
                  Office contested
                </label>
                <input
                  id="office"
                  className={input}
                  placeholder="e.g. President"
                  value={editing ? editing.office : draft.office}
                  onChange={(event) =>
                    editing
                      ? setEditing({ ...editing, office: event.target.value })
                      : setDraft({ ...draft, office: event.target.value })
                  }
                />
              </div>
              <div className={field}>
                <label className={label} htmlFor="name">
                  Name
                </label>
                <input
                  id="name"
                  className={input}
                  placeholder="Candidate full name"
                  value={editing ? editing.name : draft.name}
                  onChange={(event) =>
                    editing
                      ? setEditing({ ...editing, name: event.target.value })
                      : setDraft({ ...draft, name: event.target.value })
                  }
                />
              </div>
              <div className={field}>
                <label className={label} htmlFor="affiliation">
                  Affiliation
                </label>
                <input
                  id="affiliation"
                  className={input}
                  placeholder="Party, panel or Independent"
                  value={editing ? (editing.affiliation ?? "") : draft.affiliation}
                  onChange={(event) =>
                    editing
                      ? setEditing({ ...editing, affiliation: event.target.value })
                      : setDraft({ ...draft, affiliation: event.target.value })
                  }
                />
              </div>
              <div className={field}>
                <label className={label} htmlFor="photoUrl">
                  Photo URL
                </label>
                <input
                  id="photoUrl"
                  className={`${input} font-mono`}
                  placeholder="https://"
                  value={editing ? (editing.photoUrl ?? "") : draft.photoUrl}
                  onChange={(event) =>
                    editing
                      ? setEditing({ ...editing, photoUrl: event.target.value })
                      : setDraft({ ...draft, photoUrl: event.target.value })
                  }
                />
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              {editing ? (
                <>
                  <button
                    type="button"
                    className={btn}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await updateCandidate(editing.id, {
                          office: editing.office,
                          name: editing.name,
                          affiliation: editing.affiliation || null,
                          photoUrl: editing.photoUrl || null,
                        });
                        setEditing(null);
                        return "Candidate updated.";
                      })
                    }
                  >
                    Save changes
                  </button>
                  <button
                    type="button"
                    className={btnSecondary}
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={btn}
                  disabled={busy || draft.office.trim().length < 2 || draft.name.trim().length < 2}
                  onClick={() =>
                    void run(async () => {
                      await createCandidate(id, {
                        office: draft.office.trim(),
                        name: draft.name.trim(),
                        affiliation: draft.affiliation.trim() || null,
                        photoUrl: draft.photoUrl.trim() || null,
                      });
                      setDraft(EMPTY_DRAFT);
                      return "Candidate added.";
                    })
                  }
                >
                  Add candidate
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
