import { useCallback, useState } from "react";
import { ApiError } from "../../api/client";
import {
  changeOwnPassword,
  createAdminAccount,
  fetchAdmins,
  updateAdminAccount,
} from "../../api/endpoints";
import type { AdminAccount, AdminRole } from "../../api/types";
import { useAuth } from "../../auth/useAuth";
import {
  Alert,
  Empty,
  Label,
  PageHeader,
  SectionRule,
  Tag,
} from "../../components/primitives";
import { useAsyncData } from "../../hooks/useAsyncData";
import {
  btn,
  btnSecondary,
  field,
  input,
  label,
  mono,
  table,
  td,
  th,
} from "../../ui/classes";

function toMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Could not load operators.";
}

function formatWhen(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ROLE_LABEL: Record<AdminRole, string> = {
  SUPER_ADMIN: "Super-admin",
  REVIEWER: "Reviewer",
};

const EMPTY_DRAFT = { name: "", email: "", role: "REVIEWER" as AdminRole };

/**
 * Operator accounts, restricted to super-admins.
 *
 * The split this screen administers is meant to read as one sentence: a **reviewer works within a
 * stage** — vetting registrations, editing drafts, managing candidates and the roll — while a
 * **super-admin moves an election between stages** and does anything the outside world sees.
 *
 * That boundary is enforced on the server, next to each operation. Hiding this page from reviewers
 * is presentation; the router refuses them regardless.
 */
export default function AdminsPage() {
  const { admin: me } = useAuth();

  const load = useCallback((signal: AbortSignal) => fetchAdmins(signal), []);
  const { data, error, loading, reload } = useAsyncData(load, toMessage);

  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  const [passwords, setPasswords] = useState({ current: "", next: "" });
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
      reload();
    } catch (caught) {
      setNotice(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * A reviewer who types this URL gets a clean refusal rather than a half-rendered screen.
   *
   * The API already returns 403, so nothing here is a security control — but rendering the full
   * page around an error, with a "New operator" button that can only fail, reads as broken rather
   * than as forbidden.
   */
  if (me && me.role !== "SUPER_ADMIN") {
    return (
      <>
        <PageHeader kicker="Restricted" title="Operators" />
        <div className="px-7 py-6">
          <Alert title="Super-admins only">
            Managing operator accounts is restricted to super-admins, because creating an account is
            granting somebody the ability to enfranchise voters. Ask a super-admin if you need an
            account changed.
          </Alert>
        </div>
      </>
    );
  }

  const rows = data?.items ?? [];
  const activeSuperAdmins = rows.filter(
    (row) => row.role === "SUPER_ADMIN" && row.isActive,
  ).length;

  return (
    <>
      <PageHeader
        kicker="Restricted"
        title="Operators"
        meta={
          <span className="text-[12.5px] text-ink/55">
            {rows.length} account{rows.length === 1 ? "" : "s"} · {activeSuperAdmins} active
            super-admin{activeSuperAdmins === 1 ? "" : "s"}
          </span>
        }
        actions={
          <>
            <button
              type="button"
              className={btnSecondary}
              onClick={() => setShowPasswordForm((value) => !value)}
            >
              Change my password
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => setCreating((value) => !value)}
            >
              New operator
            </button>
          </>
        }
      />

      <div className="px-7 py-6">
        <div className="mb-5">
          <Alert tone="quiet" title="What each role can do">
            A <strong className="font-semibold">reviewer</strong> works within a stage: vetting
            registrations, editing drafts, managing candidates and the electoral roll, and re-sending
            an individual ballot link. A <strong className="font-semibold">super-admin</strong> moves
            an election between stages — opening and closing registration, freezing and publishing
            anonymity groups, opening and closing voting — issues ballot access to a whole
            electorate, and manages these accounts.
          </Alert>
        </div>

        {notice ? (
          <div className="mb-5">
            <Alert>{notice}</Alert>
          </div>
        ) : null}
        {error ? (
          <div className="mb-5">
            <Alert title="Could not load">{error}</Alert>
          </div>
        ) : null}

        {issued ? (
          <div className="mb-5 border-2 border-accent p-5">
            <Label accent className="mb-2">
              Shown once · copy it now
            </Label>
            <p className="text-[13px] m-0 mb-3">
              The initial password for{" "}
              <strong className="font-semibold">{issued.email}</strong>. Only its hash was stored, so
              this cannot be shown again — if it is lost, deactivate the account and create another.
              Ask them to change it on first sign-in.
            </p>
            <div className={`${mono} text-[15px] bg-surface px-4 py-3 border border-ink/40 break-all`}>
              {issued.password}
            </div>
            <button
              type="button"
              className={`${btnSecondary} mt-3`}
              onClick={() => setIssued(null)}
            >
              I have saved it
            </button>
          </div>
        ) : null}

        {showPasswordForm ? (
          <div className="mb-6 border-2 border-ink/40 p-5 max-w-[560px]">
            <SectionRule>Change my password</SectionRule>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className={field}>
                <label className={label} htmlFor="currentPassword">
                  Current password
                </label>
                <input
                  id="currentPassword"
                  type="password"
                  className={input}
                  autoComplete="current-password"
                  value={passwords.current}
                  onChange={(event) =>
                    setPasswords({ ...passwords, current: event.target.value })
                  }
                />
              </div>
              <div className={field}>
                <label className={label} htmlFor="newPassword">
                  New password
                </label>
                <input
                  id="newPassword"
                  type="password"
                  className={input}
                  autoComplete="new-password"
                  value={passwords.next}
                  onChange={(event) => setPasswords({ ...passwords, next: event.target.value })}
                />
                <span className="text-[11.5px] text-ink/55">At least 12 characters.</span>
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                className={btn}
                disabled={busy || passwords.current.length < 1 || passwords.next.length < 12}
                onClick={() =>
                  void run(async () => {
                    await changeOwnPassword(passwords.current, passwords.next);
                    setPasswords({ current: "", next: "" });
                    setShowPasswordForm(false);
                    return "Your password has been changed.";
                  })
                }
              >
                Change password
              </button>
              <button
                type="button"
                className={btnSecondary}
                onClick={() => {
                  setPasswords({ current: "", next: "" });
                  setShowPasswordForm(false);
                }}
              >
                Cancel
              </button>
            </div>
            <p className="text-[11.5px] text-ink/55 mt-3 mb-0">
              Sessions are stateless, so a token issued before this change keeps working until it
              expires. To cut one off immediately, deactivate the account.
            </p>
          </div>
        ) : null}

        {creating ? (
          <div className="mb-6 border-2 border-ink/40 p-5 max-w-[720px]">
            <SectionRule>New operator</SectionRule>
            <div className="grid sm:grid-cols-3 gap-4">
              <div className={field}>
                <label className={label} htmlFor="name">
                  Name
                </label>
                <input
                  id="name"
                  className={input}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </div>
              <div className={field}>
                <label className={label} htmlFor="email">
                  Work email
                </label>
                <input
                  id="email"
                  type="email"
                  className={`${input} ${mono}`}
                  value={draft.email}
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                />
              </div>
              <div className={field}>
                <label className={label} htmlFor="role">
                  Role
                </label>
                <select
                  id="role"
                  className={input}
                  value={draft.role}
                  onChange={(event) =>
                    setDraft({ ...draft, role: event.target.value as AdminRole })
                  }
                >
                  <option value="REVIEWER">Reviewer</option>
                  <option value="SUPER_ADMIN">Super-admin</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                className={btn}
                disabled={
                  busy || draft.name.trim().length < 2 || !draft.email.includes("@")
                }
                onClick={() =>
                  void run(async () => {
                    const result = await createAdminAccount({
                      name: draft.name.trim(),
                      email: draft.email.trim().toLowerCase(),
                      role: draft.role,
                    });
                    setIssued({
                      email: result.admin.email,
                      password: result.initialPassword,
                    });
                    setDraft(EMPTY_DRAFT);
                    setCreating(false);
                    return `Created ${result.admin.name} as a ${ROLE_LABEL[
                      result.admin.role
                    ].toLowerCase()}.`;
                  })
                }
              >
                Create operator
              </button>
              <button
                type="button"
                className={btnSecondary}
                onClick={() => {
                  setDraft(EMPTY_DRAFT);
                  setCreating(false);
                }}
              >
                Cancel
              </button>
            </div>
            <p className="text-[11.5px] text-ink/55 mt-3 mb-0">
              You do not choose their password. A strong one is generated and shown to you once, so
              nothing weak gets picked on somebody else's behalf.
            </p>
          </div>
        ) : null}

        {rows.length === 0 && !loading ? (
          <Empty>No operator accounts.</Empty>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className={table}>
              <thead>
                <tr>
                  <th className={th}>Operator</th>
                  <th className={th}>Role</th>
                  <th className={th}>Status</th>
                  <th className={th}>Last sign-in</th>
                  <th className={th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row: AdminAccount) => {
                  const isMe = row.id === me?.id;
                  // Refused server-side too; disabling here just explains it up front.
                  const lastSuperAdmin =
                    row.role === "SUPER_ADMIN" && row.isActive && activeSuperAdmins <= 1;

                  return (
                    <tr key={row.id} className="hover:bg-ink/4">
                      <td className={td}>
                        <div className="font-semibold">
                          {row.name}
                          {isMe ? <span className="text-ink/55"> · you</span> : null}
                        </div>
                        <div className={`${mono} text-[11.5px] text-ink/55`}>{row.email}</div>
                      </td>
                      <td className={td}>
                        <Tag tone={row.role === "SUPER_ADMIN" ? "accent" : "neutral"}>
                          {ROLE_LABEL[row.role]}
                        </Tag>
                      </td>
                      <td className={td}>
                        {row.isActive ? (
                          <span className="text-[12px]">Active</span>
                        ) : (
                          <Tag tone="outline">Deactivated</Tag>
                        )}
                      </td>
                      <td className={`${td} text-[12px]`}>{formatWhen(row.lastLoginAt)}</td>
                      <td className={td}>
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            className={btnSecondary}
                            disabled={busy || isMe || lastSuperAdmin}
                            title={
                              isMe
                                ? "You cannot change your own role"
                                : lastSuperAdmin
                                  ? "The last active super-admin cannot be demoted"
                                  : undefined
                            }
                            onClick={() =>
                              void run(async () => {
                                const next: AdminRole =
                                  row.role === "SUPER_ADMIN" ? "REVIEWER" : "SUPER_ADMIN";
                                await updateAdminAccount(row.id, { role: next });
                                return `${row.name} is now a ${ROLE_LABEL[next].toLowerCase()}.`;
                              })
                            }
                          >
                            {row.role === "SUPER_ADMIN" ? "Make reviewer" : "Make super-admin"}
                          </button>
                          <button
                            type="button"
                            className={btnSecondary}
                            disabled={busy || isMe || (row.isActive && lastSuperAdmin)}
                            title={
                              isMe
                                ? "You cannot deactivate your own account"
                                : row.isActive && lastSuperAdmin
                                  ? "The last active super-admin cannot be deactivated"
                                  : undefined
                            }
                            onClick={() =>
                              void run(async () => {
                                await updateAdminAccount(row.id, { isActive: !row.isActive });
                                return row.isActive
                                  ? `${row.name} has been deactivated — their sessions stop working immediately.`
                                  : `${row.name} can sign in again.`;
                              })
                            }
                          >
                            {row.isActive ? "Deactivate" : "Reactivate"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-6 text-[11.5px] text-ink/55 max-w-[92ch]">
          <Label as="span" className="inline">
            Note
          </Label>{" "}
          Deactivating takes effect at once: the role and active flag are read from the database on
          every request rather than from the session token, so access is cut without waiting for a
          token to expire. Every change on this page is written to the audit record against your
          account.
        </p>
      </div>
    </>
  );
}
