import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import {
  fetchChainManifest,
  fetchElection,
  fetchRingPreview,
  formRings,
  previewPublish,
  publishRings,
} from "../../api/endpoints";
import type { GuardReport, RingPreviewGroup } from "../../api/types";
import { useAuth } from "../../auth/useAuth";
import ConfirmDialog from "../../components/ConfirmDialog";
import {
  Alert,
  Empty,
  Label,
  PageHeader,
  SectionRule,
  Stat,
  StatStrip,
} from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import { btn, btnSecondary, mono } from "../../ui/classes";

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load anonymity groups.";
}

/**
 * One group, drawn as a grid of squares — one square per voter.
 *
 * Redistributed leftovers are drawn in the accent. That distinction is the point of the whole
 * visual: it shows the admin that the remainder was absorbed into existing groups rather than
 * published as a short one, which is the difference between everybody having a 1-in-10 denial
 * and four people having a 1-in-4 one.
 */
function GroupTile({ group, targetSize }: { group: RingPreviewGroup; targetSize: number }) {
  const base = group.size - group.redistributed;

  return (
    <div className="border border-ink/40 p-2.5">
      <div className="flex justify-between text-[11px] mb-1.5">
        <span className="font-semibold">G-{String(group.index + 1).padStart(3, "0")}</span>
        <span className={group.redistributed > 0 ? "text-accent-700" : "text-ink/55"}>
          {group.size}
        </span>
      </div>
      <div className="grid grid-cols-5 gap-[3px]" aria-hidden>
        {Array.from({ length: base }, (_, index) => (
          <div key={`base-${index}`} className="aspect-square bg-ink" />
        ))}
        {Array.from({ length: group.redistributed }, (_, index) => (
          <div key={`extra-${index}`} className="aspect-square bg-accent" />
        ))}
      </div>
      <span className="sr-only">
        Group {group.index + 1}: {group.size} voters, target {targetSize}
        {group.redistributed > 0
          ? `, including ${group.redistributed} redistributed leftover voters`
          : ""}
        {group.published ? ", published" : ", not yet published"}
      </span>
    </div>
  );
}

export default function GroupsPage() {
  const { id = "" } = useParams();
  const { admin } = useAuth();

  const loadElection = useCallback((signal: AbortSignal) => fetchElection(id, signal), [id]);
  const election = useAsyncData(loadElection, toMessage);

  const loadPreview = useCallback((signal: AbortSignal) => fetchRingPreview(id, signal), [id]);
  const preview = useAsyncData(loadPreview, toMessage);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [guards, setGuards] = useState<GuardReport | null>(null);

  const canForm = election.data?.operations.formRings ?? false;
  const canPublish = election.data?.operations.publishRings ?? false;
  const canExportManifest = election.data?.operations.exportChainManifest ?? false;
  const isSuperAdmin = admin?.role === "SUPER_ADMIN";

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
      preview.reload();
      election.reload();
    } catch (caught) {
      setNotice(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Downloads the manifest each ledger node imports from disk.
   *
   * The file is saved byte-for-byte as the server produced it — the digest recorded against
   * every group is computed over exactly these bytes, so re-encoding here would produce a file
   * that no longer matches its own digest. See blockchain/ELECTION_MANIFEST.md.
   */
  async function downloadManifest() {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const { body, filename } = await fetchChainManifest(id);
      const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename ?? `election-${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(
        "Manifest downloaded. Place it beside each ledger node as election.json, or pass " +
          "--election <path>. Every node needs the same file.",
      );
    } catch (caught) {
      setNotice(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function openPublishDialog() {
    setDialogOpen(true);
    setDialogError(null);
    setGuards(null);
    try {
      setGuards(await previewPublish(id));
    } catch (caught) {
      setDialogError(toMessage(caught));
    }
  }

  async function confirmPublish() {
    setBusy(true);
    setDialogError(null);
    try {
      const outcome = await publishRings(id);
      setDialogOpen(false);
      setNotice(
        `Published ${outcome.publishedGroups} groups. Membership is now permanent.`,
      );
      preview.reload();
      election.reload();
    } catch (caught) {
      setDialogError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const data = preview.data;
  const title = election.data?.election.title ?? "Election";

  return (
    <>
      <PageHeader
        kicker={`${title} · registration closed`}
        title="Anonymity groups"
        actions={
          <>
            <Link to={`/admin/elections/${id}`} className={`${btnSecondary} no-underline`}>
              Back to election
            </Link>
            {canForm && !data?.published ? (
              <button
                type="button"
                className={btnSecondary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await formRings(id);
                    return `Formed ${result.groups} groups with a fresh shuffle (${result.fingerprint}).`;
                  })
                }
              >
                {data && data.groups > 0 ? "Re-form with new shuffle" : "Form groups"}
              </button>
            ) : null}
            {canExportManifest && data && data.groups > 0 ? (
              <button
                type="button"
                className={btnSecondary}
                disabled={busy}
                onClick={() => void downloadManifest()}
              >
                Download manifest
              </button>
            ) : null}
            {canPublish && data && data.groups > 0 && !data.published ? (
              <button
                type="button"
                className={btn}
                disabled={busy}
                onClick={() => void openPublishDialog()}
              >
                Freeze &amp; publish…
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
      {preview.error ? (
        <div className="px-7 pt-4">
          <Alert title="Could not load">{preview.error}</Alert>
        </div>
      ) : null}

      {!data ? (
        <div className="px-7 py-6">
          {preview.loading ? <p className="text-[13px] text-ink/55">Loading…</p> : null}
        </div>
      ) : (
        <>
          <StatStrip>
            <Stat label="Approved voters" value={data.voters.toLocaleString()} />
            <Stat label="Groups" value={data.groups} />
            <Stat
              label="Group size"
              value={data.smallestSize}
              suffix={
                data.largestSize !== data.smallestSize ? `–${data.largestSize}` : undefined
              }
              note={`target ${data.targetSize}, minimum ${data.minimumSize}`}
            />
            <Stat
              label="Unassigned"
              value={data.unassignedVoters}
              accent={data.unassignedVoters > 0}
            />
            <Stat
              label="Published"
              value={data.publishedGroups}
              note={data.published ? "membership is permanent" : "not yet frozen"}
            />
          </StatStrip>

          <div className="grid lg:grid-cols-[1fr_380px]">
            <div className="px-7 py-6 border-b-2 lg:border-b-0 lg:border-r-2 border-ink/40">
              <SectionRule
                action={
                  <span className="text-[11.5px] text-ink/55">each square = one voter</span>
                }
              >
                {data.published
                  ? `Published · shuffle ${data.fingerprint}`
                  : data.groups > 0
                    ? `Preview · shuffle ${data.fingerprint}, unpublished`
                    : "Preview · not yet formed"}
              </SectionRule>

              <p className="text-[12.5px] text-ink/55 max-w-[68ch] mb-4">
                Voters are shuffled with a cryptographic random source, then chunked into groups
                of {data.targetSize}.{" "}
                {data.redistributedVoters > 0 ? (
                  <>
                    The {data.redistributedVoters} leftover voter
                    {data.redistributedVoters === 1 ? " was" : "s were"} distributed into existing
                    groups rather than published as a short group — a group of one is a ballot
                    with a name on it.
                  </>
                ) : (
                  <>The electorate divided evenly, so there were no leftovers to redistribute.</>
                )}
              </p>

              {data.warnings.length > 0 ? (
                <div className="mb-4 flex flex-col gap-2">
                  {data.warnings.map((warning) => (
                    <Alert key={warning}>{warning}</Alert>
                  ))}
                </div>
              ) : null}

              {data.groups === 0 ? (
                <Empty>
                  No groups formed yet. Forming them shuffles the {data.voters} approved voters and
                  divides them into groups of {data.targetSize}.
                </Empty>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3.5">
                    {data.sample.map((group) => (
                      <GroupTile
                        key={group.index}
                        group={group}
                        targetSize={data.targetSize}
                      />
                    ))}
                  </div>
                  {data.groups > data.sample.length ? (
                    <p className="text-[12px] text-ink/55 mt-4">
                      Showing {data.sample.length} of {data.groups} groups.
                    </p>
                  ) : null}

                  <div className="mt-6">
                    <Label className="mb-2.5">Legend</Label>
                    <div className="flex flex-wrap gap-6 text-[12.5px]">
                      <span className="flex items-center gap-2">
                        <span aria-hidden className="w-3 h-3 bg-ink" />
                        Voter from the base chunk
                      </span>
                      <span className="flex items-center gap-2">
                        <span aria-hidden className="w-3 h-3 bg-accent" />
                        Redistributed leftover voter
                      </span>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="px-6 py-6">
              <Label className="mb-3">What freezing does</Label>
              <ul className="list-disc text-[12.5px] leading-relaxed pl-4.5 m-0 mb-5">
                <li>Group membership becomes permanent — nobody can be added, removed or moved.</li>
                <li>Groups are published to the ledger so ballots can be checked against them.</li>
                <li>Ballot-access links can then be sent.</li>
                <li>
                  There is no reverse operation. Not for you, not for a super-admin, and not for a
                  database edit — the ledger already holds the membership.
                </li>
              </ul>

              {data.published ? (
                <Alert title="Already published">
                  {data.publishedGroups} of {data.groups} groups are on the ledger. Membership can
                  no longer change, and the groups cannot be re-formed.
                </Alert>
              ) : !isSuperAdmin ? (
                <Alert title="Super-admin only">
                  You can review and re-form groups. Freezing and publishing them needs a
                  super-admin, and the server enforces that regardless of what this screen offers.
                </Alert>
              ) : (
                <Alert title="Check before you freeze">
                  Download nothing, sign nothing — just confirm the counts above match what you
                  expect. After publishing, a mistake here cannot be corrected.
                </Alert>
              )}

              {data.fingerprint !== "—" ? (
                <p className="text-[11.5px] text-ink/55 mt-4">
                  <span className={mono}>{data.fingerprint}</span> is a checksum of this exact
                  assignment. Re-forming changes it, so two people quoting the same fingerprint are
                  looking at the same grouping.
                </p>
              ) : null}
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={dialogOpen}
        title={`Freeze ${data?.groups ?? 0} groups and publish them?`}
        body={
          <>
            <p className="m-0 mb-2">
              {(data?.voters ?? 0).toLocaleString()} voters will be locked into their groups for{" "}
              {title}. After this, membership cannot change — not by you, not by a super-admin, and
              not by a database edit that the ledger would accept.
            </p>
            {!isSuperAdmin ? (
              <p className="m-0 text-accent-700">
                Your account is a reviewer, so the server will refuse this.
              </p>
            ) : null}
          </>
        }
        facts={[
          { label: "Election", value: title },
          { label: "Shuffle", value: <span className={mono}>{data?.fingerprint ?? "—"}</span> },
          {
            label: "Groups",
            value: `${data?.groups ?? 0} · sizes ${data?.smallestSize ?? 0}–${data?.largestSize ?? 0}`,
          },
          {
            label: "Voters",
            value: `${(data?.voters ?? 0).toLocaleString()} · ${data?.unassignedVoters ?? 0} unassigned`,
          },
        ]}
        checks={guards?.checks}
        confirmPhrase="FREEZE AND PUBLISH"
        acknowledgement="I have reviewed the group sizes and the pre-flight checks, and I understand this cannot be undone."
        confirmLabel="Freeze & publish"
        busy={busy}
        error={dialogError}
        actorName={admin?.name}
        onConfirm={() => void confirmPublish()}
        onCancel={() => setDialogOpen(false)}
      />
    </>
  );
}
