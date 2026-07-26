import { useState } from "react";
import type { DuplicateWarning, RegistrationDetail } from "../../api/types";
import { Alert, Empty, Label, SectionRule, Tag } from "../../components/primitives";
import { btn, btnSecondary, mono, textarea } from "../../ui/classes";

const FIELD_LABELS: Record<DuplicateWarning["field"], string> = {
  nationalId: "National ID",
  email: "Email address",
  publicKey: "Voting key",
};

/**
 * The four automated checks shown on the record.
 *
 * Derived from the warnings the server returned rather than re-checked here: a check that
 * "passes" in the browser because a request failed silently would be the worst possible thing
 * to show a reviewer above an Approve button.
 */
function checksFrom(warnings: DuplicateWarning[]) {
  const hit = (field: DuplicateWarning["field"]) =>
    warnings.some((warning) => warning.field === field);

  return [
    {
      key: "nationalId",
      label: hit("nationalId")
        ? "National ID is already claimed"
        : "National ID not seen before",
      passed: !hit("nationalId"),
    },
    {
      key: "email",
      label: hit("email") ? "Email address is already in use" : "Email address not seen before",
      passed: !hit("email"),
    },
    {
      key: "publicKey",
      label: hit("publicKey")
        ? "This voting key is already registered"
        : "Voting key not registered elsewhere",
      passed: !hit("publicKey"),
    },
  ];
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function RecordPanel({
  detail,
  loading,
  busy,
  electionId,
  electionTitle,
  onApprove,
  onReject,
}: {
  detail: RegistrationDetail | null;
  loading: boolean;
  busy: boolean;
  electionId?: string;
  electionTitle?: string;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
}) {
  /**
   * The rejection draft, tagged with the record it was typed against.
   *
   * A reason written for one voter must never carry over to the next: it is emailed to them
   * verbatim, so a leftover draft would send one person another person's rejection reason.
   * Comparing the tag during render drops it without an effect and without a cascading render.
   */
  const [draft, setDraft] = useState<{ id: string; reason: string; open: boolean } | null>(
    null,
  );

  const currentId = detail?.registration.id ?? "";
  const active = draft?.id === currentId ? draft : null;
  const reason = active?.reason ?? "";
  const rejecting = active?.open ?? false;

  function setReason(value: string) {
    setDraft({ id: currentId, reason: value, open: true });
  }

  function setRejecting(open: boolean) {
    setDraft({ id: currentId, reason: open ? reason : "", open });
  }

  if (!detail) {
    return (
      <div className="p-7">
        {loading ? (
          <p className="text-[13px] text-ink/55">Loading record…</p>
        ) : (
          <Empty>Select a registration from the list to review it.</Empty>
        )}
      </div>
    );
  }

  const { registration, warnings } = detail;
  const pending = registration.status === "PENDING";
  const checks = checksFrom(warnings);

  return (
    <div className="flex flex-col p-7 min-w-0">
      <div className="flex flex-wrap items-start gap-5 pb-4 border-b-2 border-ink/40">
        <div>
          <Label>Registration</Label>
          <h2 className="text-[26px] m-0 mb-1">{registration.fullName}</h2>
          <span className="text-[12.5px] text-ink/55">
            Submitted {formatWhen(registration.createdAt)}
            {registration.reviewedAt
              ? ` · reviewed ${formatWhen(registration.reviewedAt)}`
              : ""}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {pending ? (
            <>
              <button
                type="button"
                className={btnSecondary}
                disabled={busy}
                onClick={() => setRejecting(!rejecting)}
              >
                Reject…
              </button>
              <button
                type="button"
                className={btn}
                disabled={busy}
                onClick={() => onApprove(registration.id)}
              >
                Approve voter
              </button>
            </>
          ) : (
            <Tag tone={registration.status === "APPROVED" ? "neutral" : "outline"}>
              {registration.status.toLowerCase()}
            </Tag>
          )}
        </div>
      </div>

      {warnings.length > 0 ? (
        <div className="mt-4.5">
          <Alert title="Possible duplicate · resolve before approving">
            <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
              {warnings.map((warning) => (
                <li key={`${warning.field}-${warning.recordId}`}>
                  <strong className="font-semibold">{FIELD_LABELS[warning.field]}</strong> —{" "}
                  {warning.detail}
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      {registration.status === "REJECTED" && registration.rejectionReason ? (
        <div className="mt-4.5">
          <Alert title="Reason given to the voter">{registration.rejectionReason}</Alert>
        </div>
      ) : null}

      {rejecting ? (
        <div className="mt-4.5 border-2 border-ink/40 p-4">
          <Label className="mb-2">Reason — sent to the voter by email</Label>
          <textarea
            className={textarea}
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Be specific enough that they can fix it and register again."
          />
          <div className="flex gap-2 mt-2.5">
            <button
              type="button"
              className={btn}
              disabled={reason.trim().length < 3 || busy}
              onClick={() => onReject(registration.id, reason.trim())}
            >
              Reject registration
            </button>
            <button
              type="button"
              className={btnSecondary}
              disabled={busy}
              onClick={() => setRejecting(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid md:grid-cols-2 border-2 border-ink/40 mt-4.5">
        <div className="p-4.5 border-b md:border-b-0 md:border-r border-ink/40">
          <Label className="mb-2.5">Submitted details</Label>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-2 text-[13px] m-0">
            <dt className="text-ink/55">Full name</dt>
            <dd className="m-0">{registration.fullName}</dd>
            <dt className="text-ink/55">National ID</dt>
            <dd className={`m-0 ${mono}`}>{registration.nationalId}</dd>
            <dt className="text-ink/55">Email</dt>
            <dd className={`m-0 ${mono}`}>{registration.email}</dd>
            <dt className="text-ink/55">Voting key</dt>
            <dd className={`m-0 ${mono}`}>{registration.publicKey}</dd>
          </dl>
          <p className="text-[11.5px] text-ink/55 mt-3 mb-0">
            The voting key is the public half only. The private half was generated on the voter's
            own device and never reaches this server.
          </p>
        </div>

        <div className="p-4.5">
          <Label className="mb-2.5">Automated checks</Label>
          <ul className="list-none m-0 p-0 border-t border-ink/40">
            {checks.map((check) => (
              <li
                key={check.key}
                className="flex gap-2 py-2 text-[12.5px] border-b border-ink/40"
              >
                <span
                  aria-hidden
                  className={`font-extrabold ${check.passed ? "text-ink" : "text-accent"}`}
                >
                  {check.passed ? "✓" : "!"}
                </span>
                <span>
                  <span className="sr-only">{check.passed ? "Passing: " : "Warning: "}</span>
                  {check.label}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[11.5px] text-ink/55 mt-3 mb-0">
            Identity is vetted by a person, not by a document scanner. These checks only report
            what already exists in the system.
          </p>
        </div>
      </div>

      {pending ? (
        <div className="mt-auto pt-4.5">
          <SectionRule>What approving does</SectionRule>
          <p className="text-[12.5px] text-ink/55 m-0">
            Approving records your admin id and the time against this voter, creates their entry
            on the electoral roll
            {electionTitle ? (
              <>
                {" "}
                for <strong className="font-semibold">{electionTitle}</strong>
              </>
            ) : null}
            , and makes them eligible to be placed in an anonymity group when groups are formed.
            {!electionId ? (
              <>
                {" "}
                <span className="text-accent-700">
                  No election is selected, so this voter will be vetted but not placed on any
                  roll.
                </span>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
