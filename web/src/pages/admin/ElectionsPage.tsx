import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../../api/client";
import { createElection, fetchElections } from "../../api/endpoints";
import { STATUS_LABELS } from "../../components/lifecycle";
import { Alert, Empty, PageHeader, SectionRule, Tag } from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import { btn, btnSecondary, field, input, label, table, td, textarea, th } from "../../ui/classes";

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load elections.";
}

function formatWhen(value: string | null): string {
  if (!value) return "not set";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ElectionsPage() {
  const load = useCallback((signal: AbortSignal) => fetchElections(signal), []);
  const { data, error, loading } = useAsyncData(load, toMessage);

  return (
    <>
      <PageHeader
        title="Elections"
        actions={
          <Link to="/admin/elections/new" className={`${btn} no-underline`}>
            New election
          </Link>
        }
      />

      <div className="px-7 py-6">
        {error ? <Alert title="Could not load">{error}</Alert> : null}
        {loading && !data ? <p className="text-[13px] text-ink/55">Loading…</p> : null}

        {data && data.items.length === 0 ? (
          <Empty>
            No elections yet. <Link to="/admin/elections/new">Create one</Link> to start taking
            registrations.
          </Empty>
        ) : null}

        {data && data.items.length > 0 ? (
          <div className="w-full overflow-x-auto">
            <table className={table}>
              <thead>
                <tr>
                  <th className={`${th} w-[30%]`}>Election</th>
                  <th className={th}>Stage</th>
                  <th className={th}>Voters</th>
                  <th className={th}>Groups</th>
                  <th className={th}>Ballot access</th>
                  <th className={th}>Voting closes</th>
                  <th className={th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((entry) => (
                  <tr key={entry.election.id} className="hover:bg-ink/4">
                    <td className={td}>
                      <div className="font-semibold">{entry.election.title}</div>
                      <div className="text-[11.5px] text-ink/55">
                        {entry.counts.candidates} candidates
                      </div>
                    </td>
                    <td className={td}>
                      <Tag
                        tone={
                          entry.election.status === "REGISTRATION_OPEN"
                            ? "accent"
                            : entry.election.status === "VOTING_OPEN"
                              ? "outline"
                              : "neutral"
                        }
                      >
                        {STATUS_LABELS[entry.election.status]}
                      </Tag>
                    </td>
                    <td className={`${td} tabular-nums`}>
                      {entry.counts.eligibleVoters.toLocaleString()}
                    </td>
                    <td className={`${td} tabular-nums`}>
                      {entry.counts.rings === 0
                        ? "—"
                        : `${entry.counts.ringsPublished} of ${entry.counts.rings} published`}
                    </td>
                    <td className={`${td} tabular-nums`}>
                      {entry.counts.tokensIssued === 0
                        ? "—"
                        : `${entry.counts.tokensIssued} sent · ${entry.counts.tokensRedeemed} used`}
                    </td>
                    <td className={td}>{formatWhen(entry.election.votingClosesAt)}</td>
                    <td className={td}>
                      <Link to={`/admin/elections/${entry.election.id}`} className="text-[12.5px]">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}

const EMPTY = {
  title: "",
  description: "",
  registrationClosesAt: "",
  votingOpensAt: "",
  votingClosesAt: "",
  ringSize: "10",
  chainRootIp: "",
  chainRootPort: "",
};

/**
 * Creating an election. It starts in DRAFT — nothing is public and nobody can register until an
 * admin opens registration explicitly, so a half-configured election cannot leak out.
 */
export function NewElectionPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof typeof EMPTY, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createElection({
        title: values.title.trim(),
        description: values.description.trim() || null,
        registrationClosesAt: values.registrationClosesAt
          ? new Date(values.registrationClosesAt).toISOString()
          : null,
        votingOpensAt: values.votingOpensAt
          ? new Date(values.votingOpensAt).toISOString()
          : null,
        votingClosesAt: values.votingClosesAt
          ? new Date(values.votingClosesAt).toISOString()
          : null,
        ringSize: Number(values.ringSize),
        chainRootIp: values.chainRootIp.trim() || null,
        chainRootPort: values.chainRootPort.trim() ? Number(values.chainRootPort) : null,
      });
      navigate(`/admin/elections/${result.election.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create the election.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader kicker="New" title="Create an election" />

      <form className="px-7 py-6 max-w-[820px]" onSubmit={submit} noValidate>
        <SectionRule>Details</SectionRule>

        <div className="grid md:grid-cols-2 gap-4.5">
          <div className={field}>
            <label className={label} htmlFor="title">
              Title
            </label>
            <input
              id="title"
              className={input}
              value={values.title}
              onChange={(event) => set("title", event.target.value)}
              required
            />
          </div>
          <div className={field}>
            <label className={label} htmlFor="ringSize">
              Anonymity group size
            </label>
            <input
              id="ringSize"
              type="number"
              min={10}
              className={input}
              value={values.ringSize}
              onChange={(event) => set("ringSize", event.target.value)}
            />
            <span className="text-[11.5px] text-ink/55">
              How many voters share a group. Larger means stronger anonymity; the minimum is 10.
            </span>
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
              onChange={(event) => set("chainRootIp", event.target.value)}
            />
            <span className="text-[11.5px] text-ink/55">
              This election runs its own blockchain network. Leave blank until you have one.
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
              onChange={(event) => set("chainRootPort", event.target.value)}
            />
            <span className="text-[11.5px] text-ink/55">
              The root node's HTTP port, not the port peers use to talk to each other.
            </span>
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
              onChange={(event) => set("description", event.target.value)}
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
              onChange={(event) => set("registrationClosesAt", event.target.value)}
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
              onChange={(event) => set("votingOpensAt", event.target.value)}
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
              onChange={(event) => set("votingClosesAt", event.target.value)}
            />
            <span className="text-[11.5px] text-ink/55">
              Ballot-access links expire at this time.
            </span>
          </div>
        </div>

        {error ? (
          <div className="mt-4">
            <Alert title="Could not create">{error}</Alert>
          </div>
        ) : null}

        <div className="flex gap-2 mt-5">
          <button type="submit" className={btn} disabled={busy}>
            {busy ? "Creating…" : "Create as draft"}
          </button>
          <Link to="/admin/elections" className={`${btnSecondary} no-underline`}>
            Cancel
          </Link>
        </div>

        <p className="text-[11.5px] text-ink/55 mt-4 max-w-[80ch]">
          The election is created as a draft. Nothing is visible to voters and nobody can register
          until you open registration, so an unfinished configuration cannot escape.
        </p>
      </form>
    </>
  );
}
