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

const EMPTY_DRAFT = { name: "", affiliation: "", photoUrl: "" };

/**
 * Screen 1f. One flat ballot, shown in the order it will be presented, because that ordering is
 * the thing being edited.
 *
 * A ballot with one name is outlined in the accent, because it is not a warning about tidiness —
 * voting cannot open on an uncontested election, and once registration closes this list is
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

  function move(list: Candidate[], index: number, delta: number) {
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
        next.map((candidate) => candidate.id),
      );
      return "Ballot order updated.";
    });
  }

  const ballot = candidates.data?.candidates ?? [];
  const belowMinimum = candidates.data?.belowMinimum ?? true;

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
        {ballot.length === 0 ? (
          <Empty>
            No candidates yet. Add at least two — an election needs a choice, and voting cannot
            open otherwise.
          </Empty>
        ) : (
          <div className="mb-7">
              <SectionRule accent={belowMinimum}>
                {ballot.length} candidate{ballot.length === 1 ? "" : "s"}
                {belowMinimum ? " · below minimum, needs 2" : ""}
              </SectionRule>

              <div
                className={`grid sm:grid-cols-2 lg:grid-cols-3 border-2 ${
                  belowMinimum ? "border-accent" : "border-ink/40"
                }`}
              >
                {ballot.map((candidate, index) => (
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
                            onClick={() => move(ballot, index, -1)}
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            className={btnGhost}
                            disabled={busy || index === ballot.length - 1}
                            onClick={() => move(ballot, index, 1)}
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

                {belowMinimum && editable ? (
                  <div className="p-4 border-b border-r border-ink/40 grid place-items-start content-center">
                    <button
                      type="button"
                      className={btn}
                      onClick={() => setDraft(EMPTY_DRAFT)}
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
        )}

        {editable ? (
          <div className="border-2 border-ink/40 p-5 max-w-[820px]">
            <SectionRule>{editing ? `Edit ${editing.name}` : "Add a candidate"}</SectionRule>
            <div className="grid md:grid-cols-2 gap-4">
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
                  disabled={busy || draft.name.trim().length < 2}
                  onClick={() =>
                    void run(async () => {
                      await createCandidate(id, {
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
