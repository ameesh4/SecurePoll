import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { fetchRegistrationStatus } from "../api/endpoints";
import type { KeyReplacementAvailability } from "../api/types";
import { Alert, Label } from "../components/primitives";
import { useAsyncData } from "../hooks/useAsyncData";
import { btn, btnSecondary, mono, noticeQuiet } from "../ui/classes";
import { VoterShell } from "./RegisterPage";

function toMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "We could not find that registration. Check the link in your confirmation email.";
  }
  return error instanceof ApiError ? error.message : "Could not load your registration.";
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

function formatDay(value: string | null): string {
  if (!value) return "not set";
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

/**
 * The "lost your key" affordance, shown wherever a voter looks at their own record.
 *
 * Whether it appears at all is the server's decision, not this component's: the rule depends on the
 * lifecycle state of every election the voter belongs to, and offering a replacement the server
 * would refuse is worse than explaining why it is unavailable.
 */
function KeyReplacementPrompt({
  id,
  replacement,
}: {
  id: string;
  replacement: KeyReplacementAvailability;
}) {
  if (replacement.pendingRequest) {
    return (
      <Alert title="Key replacement under review">
        An election officer is reviewing your request for a new voting key. We will email you the
        outcome. Your current key still works until then.
      </Alert>
    );
  }

  if (!replacement.available) {
    return replacement.reason ? (
      <Alert tone="quiet" title="Lost your key?">
        {replacement.reason}
      </Alert>
    ) : null;
  }

  return (
    <div className={noticeQuiet}>
      <Label className="mb-1.5">Lost your key file?</Label>
      <p className="text-[12.5px] m-0 mb-2.5">
        Nobody holds a copy of it, so it cannot be sent to you again — but you can create a
        replacement{replacement.immediate ? "" : ", which an officer will confirm"}.
      </p>
      <Link to={`/status/${id}/new-key`} className={`${btnSecondary} no-underline text-[13px]`}>
        Create a replacement key
      </Link>
    </div>
  );
}

/** One step in the voter's own progress list. */
function Step({
  state,
  children,
}: {
  state: "done" | "current" | "todo";
  children: React.ReactNode;
}) {
  return (
    <li
      className={`flex gap-3 px-4 py-3.5 text-[13px] border-b border-ink/40 last:border-b-0 ${
        state === "current" ? "bg-accent-100" : state === "todo" ? "opacity-50" : ""
      }`}
    >
      <span
        aria-hidden
        className={`font-extrabold ${state === "current" ? "text-accent" : ""}`}
      >
        {state === "done" ? "✓" : state === "current" ? "●" : "○"}
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * Screen 1l — the voter's own status page, in its three states.
 *
 * Reached from the link in the confirmation email, and authorised by nothing more than knowing
 * the registration id. That is calibrated to what is on the page: a name they typed, a decision,
 * and a rejection reason. It deliberately does not show the national ID, the email, or the key —
 * so a forwarded link discloses less than the original form did. There is nothing here about a
 * ballot, and no way to add it: the server holds no such fact.
 */
export default function VoterStatusPage() {
  const { id = "" } = useParams();
  const load = useCallback((signal: AbortSignal) => fetchRegistrationStatus(id, signal), [id]);
  const { data, error, loading } = useAsyncData(load, toMessage);

  if (error) {
    return (
      <VoterShell>
        <div className="px-6 py-8 flex-1">
          <Alert title="Not found">{error}</Alert>
          <Link to="/register" className={`${btn} no-underline mt-5 inline-flex`}>
            Register to vote
          </Link>
        </div>
      </VoterShell>
    );
  }

  if (!data) {
    return (
      <VoterShell>
        <div className="px-6 py-8 flex-1">
          {loading ? <p className="text-[13px] text-ink/55">Loading…</p> : null}
        </div>
      </VoterShell>
    );
  }

  if (data.status === "APPROVED") {
    return (
      <VoterShell>
        <div className="flex-1 flex flex-col">
          <div className="bg-accent text-bg px-6 py-7">
            <div className="font-extrabold text-[10px] tracking-[0.1em] uppercase opacity-85 mb-2">
              Approved
            </div>
            <h1 className="text-[30px] m-0 mb-2 text-bg leading-[1.05]">
              You are registered to vote
            </h1>
            <p className="text-[13.5px] m-0 opacity-90">
              {data.electionTitle ?? "Your election"}
              {data.votingOpensAt ? ` · voting opens ${formatDay(data.votingOpensAt)}` : ""}
            </p>
          </div>

          <div className="px-6 py-6 flex-1">
            <p className="text-[13.5px] mb-4.5">
              {data.anonymityGroupSize
                ? `You have been placed in a group of ${data.anonymityGroupSize} voters. Ballots from your group are indistinguishable from one another — that is what keeps your choice private.`
                : "You will be placed in a group of voters before voting opens. Ballots from a group are indistinguishable from one another, which is what keeps your choice private."}
            </p>

            <dl className="border-t-2 border-ink/40 text-[13.5px] m-0 mb-5">
              {[
                { label: "Ballot link arrives", value: formatWhen(data.votingOpensAt) },
                { label: "Voting closes", value: formatWhen(data.votingClosesAt) },
                {
                  label: "Your group size",
                  value: data.anonymityGroupSize ?? "assigned before voting",
                },
                { label: "Reference", value: <span className={mono}>{data.reference}</span> },
              ].map((row, index, all) => (
                <div
                  key={row.label}
                  className={`flex justify-between gap-3 py-2.5 ${
                    index === all.length - 1 ? "border-b-2" : "border-b"
                  } border-ink/40`}
                >
                  <dt className="text-ink/55">{row.label}</dt>
                  <dd className="m-0 font-semibold text-right">{row.value}</dd>
                </div>
              ))}
            </dl>

            <Label className="mb-2">Before voting opens</Label>
            <p className="text-[12.5px] text-ink/55 mb-3.5">
              Check you can still open your key file. If you have lost it, deal with it now rather
              than on voting day — nobody can give your old key back, so it has to be replaced.
            </p>
            <KeyReplacementPrompt id={data.id} replacement={data.keyReplacement} />
          </div>
        </div>
      </VoterShell>
    );
  }

  if (data.status === "REJECTED") {
    return (
      <VoterShell>
        <div className="px-6 py-7 flex-1">
          <Label className="mb-2.5">Not approved</Label>
          <h1 className="text-[26px] m-0 mb-2.5">We could not confirm your registration</h1>
          <p className="text-[13.5px] mb-4.5">
            Reference <span className={`${mono} font-semibold`}>{data.reference}</span>
            {data.reviewedAt ? ` · reviewed ${formatDay(data.reviewedAt)}` : ""} by an election
            officer.
          </p>

          {data.rejectionReason ? (
            <div className="border-2 border-accent px-4.5 py-4 mb-5">
              <Label accent className="mb-1.5">
                Reason given
              </Label>
              <p className="text-[13.5px] m-0">{data.rejectionReason}</p>
            </div>
          ) : null}

          <Label className="mb-2">You can register again</Label>
          <p className="text-[12.5px] mb-4">
            {data.registrationClosesAt
              ? `Registration is open until ${formatWhen(data.registrationClosesAt)}. `
              : ""}
            Re-submit with whatever the officer asked for.
          </p>

          <Link to="/register" className={`${btn} no-underline min-h-[42px]`}>
            Register again
          </Link>

          <div className="h-0.5 bg-ink/40 my-5" />
          <p className="text-[12px] text-ink/55 m-0">
            Your voting key is unchanged — you do not need to create a new one. If you believe this
            decision is wrong, reply to the email you received and an officer will look again.
          </p>
        </div>
      </VoterShell>
    );
  }

  return (
    <VoterShell>
      <div className="px-6 py-7 flex-1">
        <Label accent className="mb-2.5">
          Submitted · under review
        </Label>
        <h1 className="text-[26px] m-0 mb-2.5">Registration received</h1>
        <p className="text-[13.5px] mb-5">
          Reference <span className={`${mono} font-semibold`}>{data.reference}</span>. An officer
          will review your details
          {data.registrationClosesAt
            ? ` before registration closes on ${formatDay(data.registrationClosesAt)}`
            : ""}
          .
        </p>

        <ol className="list-none m-0 p-0 border-2 border-ink/40 mb-5">
          <Step state="done">
            Details submitted{" "}
            <span className="text-ink/55">{formatWhen(data.submittedAt)}</span>
          </Step>
          <Step state="current">
            Officer review <span className="text-ink/55">usually 2 working days</span>
          </Step>
          <Step state="todo">Placed in a voter group</Step>
          <Step state="todo">
            Ballot link emailed{" "}
            {data.votingOpensAt ? (
              <span className="text-ink/55">· {formatWhen(data.votingOpensAt)}</span>
            ) : null}
          </Step>
        </ol>

        <Alert tone="quiet">
          Your voting key is saved in{" "}
          <span className={mono}>voting-key.securepoll</span>, and in this browser if you chose to
          keep a copy. Keep the file — it is the only way to vote from another device, and nobody
          can replace it.
        </Alert>

        <div className="mt-5">
          <KeyReplacementPrompt id={data.id} replacement={data.keyReplacement} />
        </div>

        <div className="flex gap-2 mt-5">
          <button
            type="button"
            className={btnSecondary}
            onClick={() => window.location.reload()}
          >
            Check again
          </button>
        </div>

        <p className="text-[11px] text-ink/55 mt-5 mb-0">
          You can return to this page any time using the link in your confirmation email.
        </p>
      </div>
    </VoterShell>
  );
}
