import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import {
  fetchElection,
  fetchElectionAudit,
  previewTransition,
  transitionElection,
  updateElection,
} from "../../api/endpoints";
import type { ElectionOperation, ElectionStatus, TransitionPreview } from "../../api/types";
import { useAuth } from "../../auth/useAuth";
import ConfirmDialog from "../../components/ConfirmDialog";
import LifecycleRail from "../../components/LifecycleRail";
import { STATUS_LABELS } from "../../components/lifecycle";
import {
  Alert,
  Label,
  PageHeader,
  Preflight,
  SectionRule,
  Stat,
  StatStrip,
  Tag,
} from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import { btn, btnSecondary, field, input, label, mono, textarea } from "../../ui/classes";

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load this election.";
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * The actions an admin can take, and what blocks the ones they cannot.
 *
 * Every row is derived from `operations`, which the server computed from the lifecycle table.
 * Locked rows stay visible with the reason attached rather than disappearing — an admin who
 * cannot find "form groups" will look for it, whereas one who can see it greyed out with
 * "after registration closes" beside it has learnt the state machine.
 */
const ACTION_ROWS: {
  operation: ElectionOperation;
  label: string;
  blockedBy: string;
  href?: (id: string) => string;
}[] = [
  {
    operation: "reviewVoters",
    label: "Review registrations",
    blockedBy: "only while registration is open",
    href: () => "/admin/registrations",
  },
  {
    operation: "reviewVoters",
    label: "Electoral roll",
    blockedBy: "fixed once registration closes",
    href: (id) => `/admin/elections/${id}/voters`,
  },
  {
    operation: "manageCandidates",
    label: "Edit candidates",
    blockedBy: "fixed once registration closes",
    href: (id) => `/admin/elections/${id}/candidates`,
  },
  {
    operation: "formRings",
    label: "Form anonymity groups",
    blockedBy: "after registration closes",
    href: (id) => `/admin/elections/${id}/groups`,
  },
  {
    operation: "issueTokens",
    label: "Send ballot access",
    blockedBy: "after groups are published",
    href: (id) => `/admin/elections/${id}/ballot-access`,
  },
  {
    operation: "viewTally",
    label: "View the result",
    blockedBy: "after voting closes",
    href: (id) => `/admin/elections/${id}/monitoring`,
  },
];

/** Wording for the transition button, in the vocabulary the rest of the interface uses. */
const TRANSITION_LABELS: Partial<Record<ElectionStatus, string>> = {
  REGISTRATION_OPEN: "Open registration",
  RINGS_FROZEN: "Close registration",
  VOTING_OPEN: "Open voting",
  VOTING_CLOSED: "Close voting",
  TALLIED: "Publish the result",
  CANCELLED: "Cancel election",
};

const TRANSITION_BODY: Partial<Record<ElectionStatus, string>> = {
  RINGS_FROZEN:
    "Registration closes and the candidate list becomes permanent. Ballots are signed against candidate entries, so they cannot be changed or re-pointed afterwards. Voter review closes with it.",
  VOTING_OPEN:
    "Ballots start being accepted against the published anonymity groups. This cannot be reversed — a ballot already cast cannot be withdrawn from the ledger.",
  VOTING_CLOSED:
    "Every unused ballot-access link stops working immediately and expires. The tally becomes readable from the ledger. Voting cannot be reopened.",
  CANCELLED: "The election is abandoned and can no longer be advanced.",
};

export default function ElectionDetailPage() {
  const { id = "" } = useParams();
  const { admin } = useAuth();

  const load = useCallback((signal: AbortSignal) => fetchElection(id, signal), [id]);
  const { data, error, loading, reload } = useAsyncData(load, toMessage);

  const loadAudit = useCallback(
    (signal: AbortSignal) => fetchElectionAudit(id, { page: 1, pageSize: 6 }, signal),
    [id],
  );
  const audit = useAsyncData(loadAudit, () => "");

  const [target, setTarget] = useState<ElectionStatus | null>(null);
  const [preview, setPreview] = useState<TransitionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);

  async function openTransition(to: ElectionStatus) {
    setTarget(to);
    setPreview(null);
    setDialogError(null);
    try {
      setPreview(await previewTransition(id, to));
    } catch (caught) {
      setDialogError(toMessage(caught));
    }
  }

  async function confirmTransition() {
    if (!target) return;
    setBusy(true);
    setDialogError(null);
    try {
      await transitionElection(id, target);
      setTarget(null);
      setNotice(`This election is now ${STATUS_LABELS[target].toLowerCase()}.`);
      reload();
      audit.reload();
    } catch (caught) {
      setDialogError(toMessage(caught));
    } finally {
      setBusy(false);
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

  const { election, counts, operations, transitions, guards } = data;
  const editable = operations.editMetadata;
  const values = draft ?? {
    title: election.title,
    description: election.description ?? "",
    registrationClosesAt: toLocalInput(election.registrationClosesAt),
    votingOpensAt: toLocalInput(election.votingOpensAt),
    votingClosesAt: toLocalInput(election.votingClosesAt),
    ringSize: String(election.ringSize),
    chainRootIp: election.chainRootIp ?? "",
    chainRootPort: election.chainRootPort === null ? "" : String(election.chainRootPort),
  };

  function setValue(key: string, value: string) {
    setDraft({ ...values, [key]: value });
  }

  async function saveMetadata() {
    setBusy(true);
    setNotice(null);
    try {
      await updateElection(id, {
        title: values.title,
        description: values.description || null,
        registrationClosesAt: fromLocalInput(values.registrationClosesAt ?? ""),
        votingOpensAt: fromLocalInput(values.votingOpensAt ?? ""),
        votingClosesAt: fromLocalInput(values.votingClosesAt ?? ""),
        ringSize: Number(values.ringSize),
        chainRootIp: (values.chainRootIp ?? "").trim() || null,
        chainRootPort: (values.chainRootPort ?? "").trim()
          ? Number(values.chainRootPort)
          : null,
      });
      setDraft(null);
      setNotice("Saved.");
      reload();
    } catch (caught) {
      setNotice(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const forward = transitions.filter((next) => next !== "CANCELLED");
  const primary = forward[0];
  const canCancel = transitions.includes("CANCELLED");
  const needsSuperAdmin =
    target !== null && ["RINGS_FROZEN", "VOTING_OPEN", "VOTING_CLOSED"].includes(target);

  return (
    <>
      <PageHeader
        kicker="Election"
        title={election.title}
        meta={
          <Tag
            tone={
              election.status === "REGISTRATION_OPEN"
                ? "accent"
                : election.status === "VOTING_OPEN"
                  ? "outline"
                  : "neutral"
            }
          >
            {STATUS_LABELS[election.status]}
          </Tag>
        }
        actions={
          <>
            {canCancel ? (
              <button
                type="button"
                className={btnSecondary}
                onClick={() => void openTransition("CANCELLED")}
              >
                Cancel election
              </button>
            ) : null}
            {primary ? (
              <button
                type="button"
                className={btn}
                onClick={() => void openTransition(primary)}
              >
                {TRANSITION_LABELS[primary] ?? `Move to ${STATUS_LABELS[primary]}`}
              </button>
            ) : null}
          </>
        }
      />

      <LifecycleRail
        status={election.status}
        registrationClosesAt={election.registrationClosesAt}
        votingOpensAt={election.votingOpensAt}
        votingClosesAt={election.votingClosesAt}
      />

      <StatStrip>
        <Stat label="Approved voters" value={counts.eligibleVoters.toLocaleString()} />
        <Stat
          label="Candidates"
          value={counts.candidates}
          note={`${data.candidateCount} on the ballot`}
        />
        <Stat
          label="Anonymity groups"
          value={counts.rings}
          note={
            counts.rings === 0
              ? "not formed"
              : `${counts.ringsPublished} of ${counts.rings} published`
          }
        />
        <Stat
          label="Unassigned voters"
          value={data.unassignedVoters}
          accent={data.unassignedVoters > 0}
          note={data.unassignedVoters > 0 ? "could not cast a countable ballot" : "none"}
        />
      </StatStrip>

      {notice ? (
        <div className="px-7 pt-4">
          <Alert>{notice}</Alert>
        </div>
      ) : null}

      <div className="grid lg:grid-cols-[1fr_400px]">
        <div className="px-7 py-6 border-b-2 lg:border-b-0 lg:border-r-2 border-ink/40">
          <SectionRule>Details</SectionRule>

          {!editable ? (
            <div className="mb-4">
              <Alert title="No longer editable">
                Election details are fixed from the moment registration closes. Group size in
                particular: changing it after groups exist would describe an electorate that is
                no longer how it was divided.
              </Alert>
            </div>
          ) : null}

          <div className="grid md:grid-cols-2 gap-4.5 max-w-[820px]">
            <div className={field}>
              <label className={label} htmlFor="title">
                Title
              </label>
              <input
                id="title"
                className={input}
                value={values.title}
                disabled={!editable}
                onChange={(event) => setValue("title", event.target.value)}
              />
            </div>
            <div className={field}>
              <label className={label} htmlFor="ringSize">
                Group size (minimum 10)
              </label>
              <input
                id="ringSize"
                type="number"
                min={10}
                className={input}
                value={values.ringSize}
                disabled={!editable}
                onChange={(event) => setValue("ringSize", event.target.value)}
              />
            </div>
            <div className={field}>
              <label className={label} htmlFor="chainRootIp">
                Ledger root node IP
              </label>
              <input
                id="chainRootIp"
                className={input}
                placeholder="127.0.0.1"
                value={values.chainRootIp}
                disabled={!editable}
                onChange={(event) => setValue("chainRootIp", event.target.value)}
              />
              <span className="text-[11.5px] text-ink/55">
                This election runs its own blockchain network.
              </span>
            </div>
            <div className={field}>
              <label className={label} htmlFor="chainRootPort">
                Ledger root node port
              </label>
              <input
                id="chainRootPort"
                type="number"
                min={1}
                max={65535}
                className={input}
                placeholder="8000"
                value={values.chainRootPort}
                disabled={!editable}
                onChange={(event) => setValue("chainRootPort", event.target.value)}
              />
            </div>
            <div className={`${field} md:col-span-2`}>
              <label className={label} htmlFor="description">
                Description shown to voters
              </label>
              <textarea
                id="description"
                className={textarea}
                rows={3}
                value={values.description}
                disabled={!editable}
                onChange={(event) => setValue("description", event.target.value)}
              />
            </div>
            <div className={field}>
              <label className={label} htmlFor="registrationClosesAt">
                Registration closes
              </label>
              <input
                id="registrationClosesAt"
                type="datetime-local"
                className={input}
                value={values.registrationClosesAt}
                disabled={!editable}
                onChange={(event) => setValue("registrationClosesAt", event.target.value)}
              />
            </div>
            <div className={field}>
              <label className={label} htmlFor="votingOpensAt">
                Voting opens
              </label>
              <input
                id="votingOpensAt"
                type="datetime-local"
                className={input}
                value={values.votingOpensAt}
                disabled={!editable}
                onChange={(event) => setValue("votingOpensAt", event.target.value)}
              />
            </div>
            <div className={field}>
              <label className={label} htmlFor="votingClosesAt">
                Voting closes
              </label>
              <input
                id="votingClosesAt"
                type="datetime-local"
                className={input}
                value={values.votingClosesAt}
                disabled={!editable}
                onChange={(event) => setValue("votingClosesAt", event.target.value)}
              />
            </div>
          </div>

          {editable && draft ? (
            <div className="flex gap-2 mt-4">
              <button type="button" className={btn} disabled={busy} onClick={() => void saveMetadata()}>
                Save details
              </button>
              <button
                type="button"
                className={btnSecondary}
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                Discard
              </button>
            </div>
          ) : null}

          <div className="mt-8">
            <SectionRule
              action={
                <Link to={`/admin/elections/${id}/candidates`} className="text-[12.5px]">
                  Manage
                </Link>
              }
            >
              Candidates
            </SectionRule>

            {data.candidateCount === 0 ? (
              <p className="text-[12.5px] text-ink/55">
                No candidates yet. Voting cannot open until the ballot has at least two.
              </p>
            ) : (
              <div className="border-2 border-ink/40 max-w-[820px] px-4 py-3.5">
                <div className="font-semibold text-[13.5px]">
                  {data.candidateCount} on the ballot
                </div>
                <div
                  className={`text-[12px] ${
                    data.candidateCount < 2 ? "text-accent-700" : "text-ink/55"
                  }`}
                >
                  {data.candidateCount < 2
                    ? "needs at least 2 — an election needs a choice"
                    : "the ballot is contested"}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-6">
          <Label className="mb-3">Actions available now</Label>
          <div className="border-2 border-ink/40 mb-6">
            {ACTION_ROWS.map((row, index) => {
              const allowed = operations[row.operation];
              return (
                <div
                  key={row.operation}
                  className={`flex items-center gap-2.5 px-3.5 py-3 ${
                    index < ACTION_ROWS.length - 1 ? "border-b border-ink/40" : ""
                  } ${allowed ? "" : "opacity-50"}`}
                >
                  <span className={`text-[13.5px] ${allowed ? "font-semibold" : ""}`}>
                    {row.label}
                  </span>
                  {allowed && row.href ? (
                    <Link
                      to={row.href(id)}
                      className={`${btnSecondary} ml-auto no-underline text-[12.5px]`}
                    >
                      Open
                    </Link>
                  ) : (
                    <span className="ml-auto text-[11.5px]">{row.blockedBy}</span>
                  )}
                </div>
              );
            })}
          </div>

          {primary ? (
            <>
              <Label className="mb-2.5">
                Pre-flight for {TRANSITION_LABELS[primary]?.toLowerCase() ?? "the next step"}
              </Label>
              <Preflight checks={guards.checks} />
              {!guards.passed ? (
                <p className="text-[11.5px] text-ink/55 mt-2">
                  These are evaluated again on the server when you confirm, so a change made in
                  the meantime cannot slip through.
                </p>
              ) : null}
            </>
          ) : null}

          <div className="mt-6">
            <Label className="mb-2.5">Recent activity</Label>
            {audit.data && audit.data.items.length > 0 ? (
              <div className="flex flex-col gap-2 text-[12px]">
                {audit.data.items.map((row) => (
                  <div key={row.entry.id}>
                    <span className={`${mono} text-ink/55`}>
                      {new Date(row.entry.createdAt).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>{" "}
                    {row.actor?.name ?? "system"} · {row.entry.action}
                  </div>
                ))}
                <Link to={`/admin/audit?electionId=${id}`} className="text-[12px]">
                  Full audit record →
                </Link>
              </div>
            ) : (
              <p className="text-[12px] text-ink/55">Nothing recorded yet.</p>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={target !== null}
        kicker={
          preview?.irreversible ? "Irreversible · cannot be undone" : "Confirm this change"
        }
        title={
          target
            ? `${TRANSITION_LABELS[target] ?? "Advance"} for ${election.title}?`
            : "Confirm"
        }
        body={
          <>
            <p className="m-0 mb-2">
              {target ? (TRANSITION_BODY[target] ?? "") : ""}
            </p>
            {needsSuperAdmin && admin?.role !== "SUPER_ADMIN" ? (
              <p className="m-0 text-accent-700">
                This step needs a super-admin. Your account is a reviewer, so the server will
                refuse it.
              </p>
            ) : null}
          </>
        }
        facts={[
          { label: "Election", value: election.title },
          { label: "From", value: STATUS_LABELS[election.status] },
          { label: "To", value: target ? STATUS_LABELS[target] : "—" },
          { label: "Approved voters", value: counts.eligibleVoters.toLocaleString() },
        ]}
        checks={preview?.checks}
        confirmPhrase={target ? (TRANSITION_LABELS[target] ?? target).toUpperCase() : ""}
        acknowledgement={
          preview?.irreversible
            ? "I understand this cannot be undone, by me or by anyone else."
            : "I have reviewed the pre-flight checks."
        }
        confirmLabel={target ? (TRANSITION_LABELS[target] ?? "Confirm") : "Confirm"}
        busy={busy}
        error={dialogError}
        actorName={admin?.name}
        onConfirm={() => void confirmTransition()}
        onCancel={() => setTarget(null)}
      />
    </>
  );
}
