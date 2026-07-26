import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { fetchKeyRotations, reviewKeyRotation } from "../../api/endpoints";
import type { KeyRotationRow } from "../../api/types";
import { fingerprintOf } from "../../crypto/keys";
import { Pagination } from "../../components/Seg";
import { Alert, Empty, Label, PageHeader, SectionRule } from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import { btn, btnSecondary, mono, textarea } from "../../ui/classes";

const PAGE_SIZE = 20;

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load key replacements.";
}

function waitingFor(iso: string): string {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return "waiting under an hour";
  const days = Math.floor(hours / 24);
  return days === 0 ? `waiting ${hours} h` : `waiting ${days} d ${hours % 24} h`;
}

/**
 * Reviewing voters' requests to replace a lost voting key.
 *
 * This queue is the human step that keeps key replacement from becoming vote theft. The only thing
 * identifying whoever filed a request is possession of the voter's registration link, which arrived
 * by email — and the ballot link arrives by the same email. Approving here is therefore not a
 * formality: it is somebody confirming that the person asking is the person on the record.
 *
 * The reviewer is shown fingerprints rather than raw keys, because that is what can actually be
 * checked against a voter over the phone. Both keys are public, so nothing is hidden by doing so.
 */
export default function KeyRotationsPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? "1");

  const load = useCallback(
    (signal: AbortSignal) => fetchKeyRotations({ page, pageSize: PAGE_SIZE }, signal),
    [page],
  );
  const { data, error, loading, reload } = useAsyncData(load, toMessage);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The rejection draft, tagged with the request it belongs to so it cannot leak across rows. */
  const [draft, setDraft] = useState<{ id: string; reason: string } | null>(null);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
      setDraft(null);
      reload();
    } catch (caught) {
      setNotice(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const rows = data?.items ?? [];

  return (
    <>
      <PageHeader
        kicker="Manual vetting"
        title="Key replacements"
        meta={
          <span className="text-[12.5px] text-ink/55">
            Voters who have lost their voting key
          </span>
        }
      />

      {notice ? (
        <div className="px-7 pt-4">
          <Alert>{notice}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="px-7 pt-4">
          <Alert title="Could not load">{error}</Alert>
        </div>
      ) : null}

      <div className="px-7 py-6">
        <div className="mb-5">
          <Alert tone="quiet" title="Why this needs a person">
            A voting key cannot be recovered — only replaced, and only by the voter's own device. The
            request itself is authorised by nothing more than a link from their inbox, so approving it
            is the point at which somebody confirms the request is genuine. Until you approve, the
            voter's existing key keeps working.
          </Alert>
        </div>

        {rows.length === 0 && !loading ? (
          <Empty>
            No voter is waiting for a new key. Requests appear here when somebody approved has lost
            their key file.
          </Empty>
        ) : null}

        {rows.map((row: KeyRotationRow) => {
          const rejecting = draft?.id === row.request.id;
          return (
            <div key={row.request.id} className="border-2 border-ink/40 mb-5">
              <div className="flex flex-wrap items-start gap-4 px-5 py-4 border-b border-ink/40">
                <div>
                  <Label>Requested {waitingFor(row.request.createdAt)}</Label>
                  <h2 className="text-[20px] m-0 mt-0.5">{row.voter.fullName}</h2>
                  <span className="text-[12px] text-ink/55">
                    <span className={mono}>{row.voter.nationalId}</span> ·{" "}
                    <span className={mono}>{row.voter.email}</span>
                  </span>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btnSecondary}
                    disabled={busy}
                    onClick={() =>
                      setDraft(rejecting ? null : { id: row.request.id, reason: "" })
                    }
                  >
                    Reject…
                  </button>
                  <button
                    type="button"
                    className={btn}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await reviewKeyRotation(row.request.id, true);
                        return `${row.voter.fullName}'s new key is now active.`;
                      })
                    }
                  >
                    Approve new key
                  </button>
                </div>
              </div>

              <div className="grid md:grid-cols-2">
                <div className="px-5 py-4 border-b md:border-b-0 md:border-r border-ink/40">
                  <Label className="mb-2">The change</Label>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-2 text-[13px] m-0">
                    <dt className="text-ink/55">Current key</dt>
                    <dd className={`m-0 ${mono}`}>
                      {fingerprintOf(row.request.previousPublicKey)}
                    </dd>
                    <dt className="text-ink/55">New key</dt>
                    <dd className={`m-0 ${mono} text-accent-700 font-semibold`}>
                      {fingerprintOf(row.request.newPublicKey)}
                    </dd>
                  </dl>
                  <p className="text-[11.5px] text-ink/55 mt-3 mb-0">
                    Read the new fingerprint back to the voter to confirm they created it. Groups
                    already published keep the key they were published with, so approving this
                    cannot disturb an election already under way.
                  </p>
                </div>

                <div className="px-5 py-4">
                  <Label className="mb-2">What the voter said</Label>
                  <p className="text-[13px] m-0">
                    {row.request.reason ? (
                      row.request.reason
                    ) : (
                      <span className="text-ink/55">No reason given.</span>
                    )}
                  </p>
                  <div className="h-px bg-ink/40 my-3.5" />
                  <Label className="mb-1.5">Registered</Label>
                  <p className="text-[12.5px] text-ink/55 m-0">
                    {new Date(row.registration.createdAt).toLocaleString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                    , reviewed{" "}
                    {row.registration.reviewedAt
                      ? new Date(row.registration.reviewedAt).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                        })
                      : "—"}
                  </p>
                </div>
              </div>

              {rejecting ? (
                <div className="px-5 py-4 border-t border-ink/40">
                  <SectionRule>Reason — emailed to the voter</SectionRule>
                  <textarea
                    className={textarea}
                    rows={2}
                    value={draft.reason}
                    onChange={(event) =>
                      setDraft({ id: row.request.id, reason: event.target.value })
                    }
                    placeholder="e.g. Could not confirm your identity — please come to the election office."
                  />
                  <div className="flex gap-2 mt-2.5">
                    <button
                      type="button"
                      className={btn}
                      disabled={draft.reason.trim().length < 3 || busy}
                      onClick={() =>
                        void run(async () => {
                          await reviewKeyRotation(
                            row.request.id,
                            false,
                            draft.reason.trim(),
                          );
                          return `Rejected. ${row.voter.fullName} has been emailed the reason and keeps their existing key.`;
                        })
                      }
                    >
                      Reject request
                    </button>
                    <button
                      type="button"
                      className={btnSecondary}
                      disabled={busy}
                      onClick={() => setDraft(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        {data && data.total > PAGE_SIZE ? (
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={PAGE_SIZE}
            onPage={(next) =>
              setParams((current) => {
                const updated = new URLSearchParams(current);
                updated.set("page", String(next));
                return updated;
              })
            }
          />
        ) : null}
      </div>
    </>
  );
}
