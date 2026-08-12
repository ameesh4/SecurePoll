import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { fetchRegistrationStatus, replaceVotingKey } from "../api/endpoints";
import { Alert, Label } from "../components/primitives";
import {
  downloadKeyFile,
  fingerprintOf,
  generateVoterKeyPair,
  VOTING_KEY_STORAGE_KEY,
  type VoterKeyPair,
} from "../crypto/keys";
import { useAsyncData } from "../hooks/useAsyncData";
import { btn, btnSecondary, mono, textarea } from "../ui/classes";
import { VoterShell } from "./RegisterPage";

function toMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "We could not find that registration. Check the link in your confirmation email.";
  }
  return error instanceof ApiError ? error.message : "Could not load your registration.";
}

/**
 * Replacing a lost voting key.
 *
 * Nobody can give a voter their key back — it was generated on their device and the private half
 * never reached the server, which is the property the whole scheme rests on. So the only remedy is
 * a *new* key, and only the voter can make one.
 *
 * What this page cannot be is a one-click self-service swap. The only thing identifying whoever
 * opens it is the link from the voter's email, and the ballot link arrives by that same email.
 * Today an attacker with that inbox can collect a ballot link but cannot sign with it. If they could
 * also install a key of their own, they could cast the vote. So an approved voter's replacement is
 * reviewed by an election officer; a registration nobody has looked at yet is simply corrected,
 * because there is nothing to protect and an officer is about to read it anyway.
 */
export default function ReplaceKeyPage() {
  const { id = "" } = useParams();

  const load = useCallback((signal: AbortSignal) => fetchRegistrationStatus(id, signal), [id]);
  const { data, error, loading, reload } = useAsyncData(load, toMessage);

  const [keyPair, setKeyPair] = useState<VoterKeyPair | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ applied: boolean } | null>(null);

  function handleGenerate() {
    // Generated once per visit and kept, so a voter who has already downloaded the file cannot end
    // up submitting a different key than the one they saved.
    if (!keyPair) setKeyPair(generateVoterKeyPair());
  }

  function handleDownload() {
    if (!keyPair) return;
    downloadKeyFile(keyPair, "voting-key-replacement.securepoll");
    setDownloaded(
      new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    );
  }

  async function submit() {
    if (!keyPair || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // The public half only. The private key stays in the downloaded file and, if the browser
      // allows it, in this browser — it is never part of this request.
      const result = await replaceVotingKey(id, keyPair.publicKey, reason.trim() || undefined);

      try {
        localStorage.setItem(
          VOTING_KEY_STORAGE_KEY,
          JSON.stringify({ ...keyPair, registrationId: id }),
        );
      } catch {
        // Blocked or full storage is not a reason to fail: the downloaded file is the copy that
        // matters, and the request has already been accepted.
      }

      setOutcome({ applied: result.applied });
      reload();
    } catch (caught) {
      setSubmitError(toMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

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

  const replacement = data.keyReplacement;

  // ── Done ──────────────────────────────────────────────────────────────────────────────────
  if (outcome) {
    return (
      <VoterShell>
        <div className="px-6 py-7 flex-1">
          <Label accent className="mb-2.5">
            {outcome.applied ? "New key saved" : "Sent for review"}
          </Label>
          <h1 className="text-[26px] m-0 mb-2.5">
            {outcome.applied ? "Your new key is on your registration" : "An officer will review it"}
          </h1>

          {outcome.applied ? (
            <p className="text-[13.5px] mb-4.5">
              Your registration now carries the new key, and the officer reviewing it will see that
              one. Keep the file you just downloaded — it is the only copy.
            </p>
          ) : (
            <p className="text-[13.5px] mb-4.5">
              Because your registration has already been approved, an election officer has to confirm
              this request before the new key takes effect. We will email you the outcome.{" "}
              <strong className="font-semibold">Your existing key is unchanged until then.</strong>
            </p>
          )}

          <div className="border-2 border-ink p-4.5 mb-5">
            <Label className="mb-1.5">Your new key</Label>
            <div className={`${mono} text-[12px]`}>
              fingerprint{" "}
              <span className="text-accent-700 font-semibold">
                {keyPair ? fingerprintOf(keyPair.publicKey) : "—"}
              </span>
            </div>
            <p className="text-[11.5px] text-ink/55 mt-2 mb-0">
              Saved to <span className={mono}>voting-key-replacement.securepoll</span>. An officer
              may read this fingerprint back to you.
            </p>
          </div>

          <Alert>
            Nobody holds a copy of this key but you. If you lose it too, you will have to go through
            this again.
          </Alert>

          <Link to={`/status/${id}`} className={`${btn} no-underline mt-5 inline-flex`}>
            Back to my registration
          </Link>
        </div>
      </VoterShell>
    );
  }

  // ── Cannot replace ────────────────────────────────────────────────────────────────────────
  if (!replacement.available) {
    return (
      <VoterShell>
        <div className="px-6 py-7 flex-1">
          <Label className="mb-2.5">Cannot be replaced</Label>
          <h1 className="text-[26px] m-0 mb-2.5">
            {replacement.pendingRequest
              ? "You already have a request waiting"
              : "Your key cannot be replaced now"}
          </h1>

          {replacement.pendingRequest ? (
            <p className="text-[13.5px] mb-4.5">
              An election officer is reviewing a key replacement for you already. We will email you
              when they have looked at it. Until then your existing key is unchanged.
            </p>
          ) : (
            <p className="text-[13.5px] mb-4.5">
              {replacement.reason ??
                "Replacing your key is not possible at the moment. Speak to an election officer."}
            </p>
          )}

          {replacement.alreadyFrozen.length > 0 ? (
            <div className="mb-5">
              <Label className="mb-2">Already closed to changes</Label>
              <ul className="list-none m-0 p-0 border-2 border-ink/40 text-[12.5px]">
                {replacement.alreadyFrozen.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex justify-between gap-3 px-3.5 py-2.5 border-b border-ink/40 last:border-b-0"
                  >
                    <span>{entry.title}</span>
                    <span className="text-ink/55">{entry.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Link to={`/status/${id}`} className={`${btnSecondary} no-underline inline-flex`}>
            Back to my registration
          </Link>
        </div>
      </VoterShell>
    );
  }

  // ── The flow ──────────────────────────────────────────────────────────────────────────────
  return (
    <VoterShell>
      <div className="px-6 py-7 flex-1">
        <Label accent className="mb-2.5">
          Lost your voting key
        </Label>
        <h1 className="text-[26px] m-0 mb-2.5">Create a replacement key</h1>
        <p className="text-[13.5px] mb-4.5">
          Nobody can give you your old key back — it was made on your device and we never received
          it. What we can do is put a new key on your record.
        </p>

        <div className="mb-5">
          <Alert title="This replaces your old key">
            Once the new key is in place, the old one stops working. If you later find your old file,
            it will no longer let you vote.
          </Alert>
        </div>

        {replacement.immediate ? (
          <p className="text-[12.5px] text-ink/55 mb-5">
            Your registration has not been reviewed yet, so the new key goes straight onto it.
          </p>
        ) : (
          <div className="mb-5">
            <Alert tone="quiet" title="An officer checks this first">
              Your registration is already approved, so a person confirms the request before the new
              key takes effect — that is what stops somebody who reaches your email from voting as
              you. Your current key keeps working until they do.
            </Alert>
          </div>
        )}

        {replacement.appliesTo.length > 0 ? (
          <div className="mb-5">
            <Label className="mb-2">The new key will apply to</Label>
            <ul className="list-none m-0 p-0 border-2 border-ink/40 text-[12.5px]">
              {replacement.appliesTo.map((entry) => (
                <li key={entry.id} className="px-3.5 py-2.5 border-b border-ink/40 last:border-b-0">
                  {entry.title}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {replacement.alreadyFrozen.length > 0 ? (
          <div className="mb-5">
            <Label className="mb-2">It will not help with</Label>
            <ul className="list-none m-0 p-0 border-2 border-ink/40 text-[12.5px]">
              {replacement.alreadyFrozen.map((entry) => (
                <li
                  key={entry.id}
                  className="flex justify-between gap-3 px-3.5 py-2.5 border-b border-ink/40 last:border-b-0"
                >
                  <span>{entry.title}</span>
                  <span className="text-ink/55">{entry.status}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11.5px] text-ink/55 mt-2">
              Those elections have already fixed their voter groups against your old key, and a group
              cannot be changed once published.
            </p>
          </div>
        ) : null}

        {!keyPair ? (
          <button type="button" className={`${btn} min-h-[42px]`} onClick={handleGenerate}>
            Create a new key
          </button>
        ) : (
          <>
            <div className="border-2 border-ink p-4.5 mb-4.5">
              <Label className="mb-1.5">New key created on this device</Label>
              <div className={`${mono} text-[12px]`}>
                fingerprint{" "}
                <span className="text-accent-700 font-semibold">
                  {fingerprintOf(keyPair.publicKey)}
                </span>
              </div>
            </div>

            <div className="border-2 border-ink/40 px-4 py-3.5 mb-4">
              <div className="flex items-center gap-2.5 mb-1.5">
                <span className="font-extrabold text-[13.5px]">Download the key file</span>
                <span className="ml-auto inline-flex items-center text-[11px] px-2.5 py-0.5 bg-accent-100 text-accent-800">
                  Required
                </span>
              </div>
              <p className="text-[12px] text-ink/55 m-0 mb-2.5">
                Save it somewhere you will not lose it this time — a USB drive, or your own cloud
                folder.
              </p>
              <button type="button" className={btn} onClick={handleDownload}>
                Download voting-key-replacement.securepoll
              </button>
              {downloaded ? (
                <div className="text-[11.5px] font-semibold mt-2">✓ Downloaded {downloaded}</div>
              ) : null}
            </div>

            <label className="block mb-4">
              <Label className="mb-1.5">Why do you need a new key? (optional)</Label>
              <textarea
                className={textarea}
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. my laptop was reset and I had not saved the file"
              />
              <span className="text-[11.5px] text-ink/55">
                An officer reads this when deciding.
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-[13px] mb-4 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I have saved this key file, and I understand my old key will stop working and this
                one cannot be recovered either.
              </span>
            </label>

            {submitError ? (
              <div className="mb-4">
                <Alert title="Could not submit">{submitError}</Alert>
              </div>
            ) : null}

            <div className="flex gap-2">
              <button
                type="button"
                className={`${btn} flex-1 min-h-[42px]`}
                disabled={!downloaded || !acknowledged || submitting}
                title={!downloaded ? "Download the key file first" : undefined}
                onClick={() => void submit()}
              >
                {submitting
                  ? "Submitting…"
                  : replacement.immediate
                    ? "Use this key"
                    : "Send for review"}
              </button>
              <Link
                to={`/status/${id}`}
                className={`${btnSecondary} no-underline min-h-[42px] inline-flex items-center`}
              >
                Cancel
              </Link>
            </div>
          </>
        )}
      </div>
    </VoterShell>
  );
}
