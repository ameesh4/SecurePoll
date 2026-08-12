import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { submitRegistration } from "../api/endpoints";
import { Alert, Label } from "../components/primitives";
import {
  downloadKeyFile,
  fingerprintOf,
  generateVoterKeyPair,
  VOTING_KEY_STORAGE_KEY,
  type VoterKeyPair,
} from "../crypto/keys";
import { btn, btnSecondary, field, input, label, mono } from "../ui/classes";

const CONFLICT_LABELS: Record<string, string> = {
  nationalId: "national ID number",
  email: "email address",
  publicKey: "voting key",
};

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const steps = ["Your details", "Voting key", "Submit"] as const;
  return (
    <ol className="grid grid-cols-3 list-none m-0 p-0">
      {steps.map((title, index) => {
        const number = index + 1;
        const done = number < step;
        const current = number === step;
        return (
          <li
            key={title}
            aria-current={current ? "step" : undefined}
            className={`px-3.5 py-2.5 font-extrabold text-[11px] uppercase tracking-[0.04em] border-b-[3px] ${
              current
                ? "border-b-accent text-accent-700"
                : done
                  ? "border-b-ink opacity-55"
                  : "border-b-neutral-300 opacity-45"
            }`}
          >
            {number} · {done ? "Done" : title}
          </li>
        );
      })}
    </ol>
  );
}

export function VoterShell({
  children,
  kicker = "Voter registration",
}: {
  children: React.ReactNode;
  kicker?: string;
}) {
  return (
    <main className="min-h-screen bg-[#d9d7d6] grid place-items-start sm:place-items-center py-0 sm:py-10 px-0 sm:px-4">
      <div className="w-full max-w-[520px] bg-bg sm:border-2 sm:border-ink/40 flex flex-col min-h-screen sm:min-h-0">
        <div className="flex items-center gap-2.5 px-6 py-4 border-b-2 border-ink/40">
          <span className="font-extrabold text-[15px]">
            SECURE<span className="text-accent">POLL</span>
          </span>
          <span className="ml-auto text-[11.5px] text-ink/55">{kicker}</span>
        </div>
        {children}
        <div className="px-6 py-3.5 border-t-2 border-ink/40 flex gap-3.5 text-[11px] text-ink/55">
          <span>Gandaki College of Engineering and Science</span>
          <Link to="/admin/login" className="ml-auto text-[11px]">
            Officer sign-in
          </Link>
        </div>
      </div>
    </main>
  );
}

/**
 * Screen 1k — registration in three steps, responsive at 520px.
 *
 * The middle step exists because of *where* the keypair is generated. It is created here, in the
 * browser, and the private half is never put in a request body: that is the basis of the whole
 * anonymity argument, since a server holding the key could forge a ballot and could link a
 * signature back to a name. The unavoidable consequence is that nobody can recover it for the
 * voter — which is why this step refuses to continue until the file has actually been downloaded.
 */
export default function RegisterPage() {
  const navigate = useNavigate();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [form, setForm] = useState({ fullName: "", nationalId: "", email: "" });
  const [confirmed, setConfirmed] = useState(false);
  const [keyPair, setKeyPair] = useState<VoterKeyPair | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [keepInBrowser, setKeepInBrowser] = useState(true);
  const [acknowledgedLoss, setAcknowledgedLoss] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function set(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function goToKeyStep(event: React.FormEvent) {
    event.preventDefault();
    // Generated once and kept, so stepping back and forth cannot silently swap the key for a new
    // one after the voter has already saved the old one to a file.
    if (!keyPair) setKeyPair(generateVoterKeyPair());
    setStep(2);
  }

  function handleDownload() {
    if (!keyPair) return;
    downloadKeyFile(keyPair);
    setDownloaded(
      new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    );
  }

  async function submit() {
    if (!keyPair || submitting) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const receipt = await submitRegistration({
        fullName: form.fullName.trim(),
        nationalId: form.nationalId.trim(),
        email: form.email.trim().toLowerCase(),
        // The public half only. There is no field on this request for the private key, and the
        // server has no column to put one in.
        publicKey: keyPair.publicKey,
      });

      if (keepInBrowser) {
        try {
          localStorage.setItem(
            VOTING_KEY_STORAGE_KEY,
            JSON.stringify({ ...keyPair, registrationId: receipt.id }),
          );
        } catch {
          // Full or blocked storage is not a reason to fail a registration that has already been
          // accepted — the voter still holds the downloaded file, which is the copy that matters.
        }
      }

      navigate(`/status/${receipt.id}`, { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors);
        const fields = (caught.details as { fields?: string[] } | undefined)?.fields;
        setError(
          fields?.length
            ? `That ${fields
                .map((name) => CONFLICT_LABELS[name] ?? name)
                .join(" and ")} is already registered. If that was you, use the link in your confirmation email rather than registering again.`
            : caught.message,
        );
      } else {
        setError("Could not submit your registration. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const detailsReady =
    form.fullName.trim().length >= 2 &&
    form.nationalId.trim().length >= 4 &&
    /.+@.+\..+/.test(form.email.trim()) &&
    confirmed;

  return (
    <VoterShell>
      <Stepper step={step} />

      {step === 1 ? (
        <form className="px-6 py-6 flex-1" onSubmit={goToKeyStep} noValidate>
          <h1 className="text-2xl m-0 mb-2">Register to vote</h1>
          <p className="text-[13px] mb-5">
            An election officer checks your details against the student roll. You will be emailed
            when your registration has been reviewed — usually within two working days.
          </p>

          <div className="flex flex-col gap-4">
            <div className={field}>
              <label className={label} htmlFor="fullName">
                Full name — as printed on your student ID
              </label>
              <input
                id="fullName"
                className={input}
                value={form.fullName}
                onChange={(event) => set("fullName", event.target.value)}
                autoComplete="name"
                required
              />
            </div>

            <div className={field}>
              <label className={label} htmlFor="nationalId">
                National ID number
              </label>
              <input
                id="nationalId"
                className={`${input} ${mono}`}
                value={form.nationalId}
                onChange={(event) => set("nationalId", event.target.value)}
                required
              />
              <span className="text-[11.5px] text-ink/55">
                Used once, to confirm you appear on the roll.
              </span>
              {fieldErrors.nationalId ? (
                <span className="text-[11.5px] text-accent-700">
                  {fieldErrors.nationalId[0]}
                </span>
              ) : null}
            </div>

            <div className={field}>
              <label className={label} htmlFor="email">
                Institutional email
              </label>
              <input
                id="email"
                type="email"
                className={`${input} ${mono}`}
                value={form.email}
                onChange={(event) => set("email", event.target.value)}
                autoComplete="email"
                required
              />
              <span className="text-[11.5px] text-ink/55">
                Your ballot link is sent here.
              </span>
              {fieldErrors.email ? (
                <span className="text-[11.5px] text-accent-700">{fieldErrors.email[0]}</span>
              ) : null}
            </div>

            <Alert tone="quiet">
              We record that you are eligible to vote. We never record how you vote — the two facts
              are kept apart by design, not by policy.
            </Alert>

            <label className="flex items-start gap-2.5 text-[13px] cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>I confirm these details are mine and are accurate.</span>
            </label>

            <button
              type="submit"
              className={`${btn} w-full min-h-[42px]`}
              disabled={!detailsReady}
            >
              Continue to voting key
            </button>
          </div>
        </form>
      ) : null}

      {step === 2 && keyPair ? (
        <div className="px-6 py-6 flex-1">
          <h1 className="text-2xl m-0 mb-2">Your voting key</h1>
          <p className="text-[13px] mb-4.5">
            This device has just created a key that only you hold. It is what lets you cast a ballot
            without your name being attached to it. It was created here and is not sent to us.
          </p>

          <div className="border-2 border-ink p-4.5 mb-4.5">
            <Label className="mb-1.5">Key created</Label>
            <div className={`${mono} text-[12px] leading-relaxed text-ink/75`}>
              voting-key ·{" "}
              {new Date().toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}{" "}
              · fingerprint{" "}
              <span className="text-accent-700 font-semibold">
                {fingerprintOf(keyPair.publicKey)}
              </span>
            </div>
            <p className="text-[11.5px] text-ink/55 mt-2 mb-0">
              The fingerprint is a short name for your key. An officer may read it back to you if
              you ever need help.
            </p>
          </div>

          <Label className="mb-2.5">Keep two copies</Label>
          <div className="border-2 border-ink/40 mb-4">
            <div className="px-4 py-3.5 border-b border-ink/40">
              <div className="flex items-center gap-2.5 mb-1.5">
                <span className="font-extrabold text-[13.5px]">1. Download the key file</span>
                <span className="ml-auto inline-flex items-center text-[11px] px-2.5 py-0.5 bg-accent-100 text-accent-800">
                  Required
                </span>
              </div>
              <p className="text-[12px] text-ink/55 m-0 mb-2.5">
                A small file you keep somewhere safe — a USB drive, or your own cloud folder. This
                is the only way back if you lose this browser.
              </p>
              <button type="button" className={btn} onClick={handleDownload}>
                Download voting-key.securepoll
              </button>
              {downloaded ? (
                <div className="text-[11.5px] font-semibold mt-2">✓ Downloaded {downloaded}</div>
              ) : null}
            </div>

            <div className="px-4 py-3.5">
              <div className="flex items-center gap-2.5 mb-1.5">
                <span className="font-extrabold text-[13.5px]">
                  2. Keep a copy in this browser
                </span>
                <span className="ml-auto inline-flex items-center text-[11px] px-2.5 py-0.5 bg-neutral-100 text-neutral-800">
                  Recommended
                </span>
              </div>
              <p className="text-[12px] text-ink/55 m-0 mb-2.5">
                Lets you vote on this device without opening the file. Clearing your browser data,
                or using a different device, removes it.
              </p>
              <label className="flex items-center gap-2.5 text-[13px] cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={keepInBrowser}
                  onChange={(event) => setKeepInBrowser(event.target.checked)}
                />
                <span>Save a copy in this browser</span>
              </label>
            </div>
          </div>

          <div className="mb-4.5">
            <Alert title="There is no reset">
              Nobody — not the college, not an election officer — holds a copy of your key. If you
              lose both copies before voting, you must register again and be re-approved.
            </Alert>
          </div>

          <label className="flex items-start gap-2.5 text-[13px] mb-4 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 accent-accent"
              checked={acknowledgedLoss}
              onChange={(event) => setAcknowledgedLoss(event.target.checked)}
            />
            <span>I have saved my key file and understand it cannot be recovered.</span>
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              className={`${btn} flex-1 min-h-[42px]`}
              disabled={!downloaded || !acknowledgedLoss}
              title={!downloaded ? "Download the key file first" : undefined}
              onClick={() => setStep(3)}
            >
              Continue
            </button>
            <button
              type="button"
              className={`${btnSecondary} min-h-[42px]`}
              onClick={() => setStep(1)}
            >
              Back
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 && keyPair ? (
        <div className="px-6 py-6 flex-1">
          <h1 className="text-2xl m-0 mb-2">Check and submit</h1>
          <p className="text-[13px] mb-4.5">
            These details go to an election officer for review. Only the public half of your key is
            sent — the part that lets your ballot be checked, never the part that could open it.
          </p>

          <dl className="border-t-2 border-ink/40 text-[13.5px] m-0">
            {[
              { label: "Name", value: form.fullName },
              { label: "National ID", value: <span className={mono}>{form.nationalId}</span> },
              {
                label: "Email",
                value: <span className={`${mono} text-[12px]`}>{form.email}</span>,
              },
              {
                label: "Key fingerprint",
                value: (
                  <span className={`${mono} text-accent-700 font-semibold`}>
                    {fingerprintOf(keyPair.publicKey)}
                  </span>
                ),
              },
              {
                label: "Key file saved",
                value: keepInBrowser ? "Yes · file + this browser" : "Yes · file only",
              },
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

          {error ? (
            <div className="mt-4">
              <Alert title="Could not submit">{error}</Alert>
            </div>
          ) : null}

          <div className="flex gap-2 mt-5 mb-6">
            <button
              type="button"
              className={`${btn} min-h-[42px]`}
              disabled={submitting}
              onClick={() => void submit()}
            >
              {submitting ? "Submitting…" : "Submit registration"}
            </button>
            <button
              type="button"
              className={`${btnSecondary} min-h-[42px]`}
              disabled={submitting}
              onClick={() => setStep(2)}
            >
              Back
            </button>
          </div>

          <div className="h-0.5 bg-ink/40 mb-4" />
          <Label className="mb-2.5">What happens next</Label>
          <ol className="list-none m-0 p-0 text-[12.5px]">
            {[
              "An officer checks your details against the roll.",
              "You are emailed the outcome — approved, or the reason for rejection.",
              "If approved, you are placed in a group of voters whose ballots are indistinguishable from one another.",
              "When voting opens, a ballot link arrives by email.",
            ].map((text, index, all) => (
              <li
                key={text}
                className={`flex gap-3 py-2.5 ${
                  index < all.length - 1 ? "border-b border-ink/40" : ""
                }`}
              >
                <span className={`${mono} text-ink/55`}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </VoterShell>
  );
}
