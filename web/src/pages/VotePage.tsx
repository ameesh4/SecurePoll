import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import { collectBallot } from "../api/endpoints";
import type { RingRetrieval } from "../api/types";
import { Alert, Label } from "../components/primitives";
import { fingerprintOf, parseKeyFile, type VoterKeyPair } from "../crypto/keys";
import {
  encodeMessage,
  fromBase64Url,
  serializeSignature,
  sign,
  toBase64Url,
} from "../crypto/lrs";
import { saveVoteReceipt } from "../lib/voteReceipts";
import { btn, btnSecondary, hint, mono, textarea } from "../ui/classes";
import { VoterShell } from "./RegisterPage";

/**
 * Casting a ballot.
 *
 * The whole anonymity argument lives in this file's sequence, so it is worth stating plainly:
 *
 *  - The ballot is signed **here, in the browser**, with a private key this page reads from a file
 *    the voter holds. The key is never transmitted.
 *  - The signed ballot goes **straight to a ledger node**, not back through the verification
 *    server. That server must never see a ballot (SECUREPOLL_CONTEXT.md §4 invariant 4), which is
 *    also why the node has to accept cross-origin requests rather than us proxying.
 *  - The access credential is spent against the verification server to *collect the group*, and is
 *    never sent to the node. Token and signature are never observed together — that separation is
 *    the correction in §4.1.
 *
 * The voter's own position in the group is found locally by deriving their public key and matching
 * it: the server deliberately refuses to say which member they are.
 */

type Stage = "collecting" | "ready" | "casting" | "cast";

/** What the node replies, in words a voter can act on. */
const NODE_REPLIES: Record<string, string> = {
  DOUBLE_VOTE:
    "A ballot has already been cast with this voting key. Each voter may vote once, and the " +
    "ledger cannot tell us which ballot was yours — only that this key has been used.",
  INVALID_SIGNATURE:
    "The ledger rejected the signature on that ballot. This usually means the voting key does not " +
    "match the group you were placed in.",
  WRONG_ELECTION: "That ledger is serving a different election. Contact the election office.",
  UNKNOWN_RING:
    "The ledger does not recognise your anonymity group. Its copy of the election may be out of " +
    "date — contact the election office.",
  INVALID_CANDIDATE: "The ledger does not recognise that candidate.",
  MALFORMED_SIGNATURE: "The ballot was not built correctly. Please reload and try again.",
};

function collectMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "This ballot link is not valid. It may have expired, or voting may have closed.";
  }
  return error instanceof ApiError
    ? error.message
    : "Could not reach the election server to collect your ballot.";
}

export default function VotePage() {
  // Captured once, before the effect below strips it from the address bar.
  const [token] = useState(() => new URLSearchParams(window.location.search).get("access") ?? "");

  // A missing token is knowable at first render, so it is derived rather than set from an effect.
  const [stage, setStage] = useState<Stage>(token ? "collecting" : "ready");
  const [ballot, setBallot] = useState<RingRetrieval | null>(null);
  const [error, setError] = useState<string | null>(
    token ? null : "This page needs the ballot link from your email.",
  );
  const [key, setKey] = useState<VoterKeyPair | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [choice, setChoice] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Take the credential out of the URL as soon as it has been read.
   *
   * It is a bearer credential sitting in a query string, so left alone it persists in browser
   * history and can leak to any third party through the `Referer` header. `index.html` also sets
   * `referrer: no-referrer` for the same reason.
   */
  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    collectBallot(token)
      .then((data) => {
        if (cancelled) return;
        setBallot(data);
        setStage("ready");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(collectMessage(caught));
        setStage("ready");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  /** Where this voter sits in the published group, or -1 if their key is not in it. */
  const signerIndex =
    key && ballot ? ballot.publicKeys.indexOf(key.publicKey) : -1;

  const loadKeyText = useCallback((text: string) => {
    setKeyError(null);
    try {
      setKey(parseKeyFile(text));
    } catch (caught) {
      setKey(null);
      setKeyError(caught instanceof Error ? caught.message : "That key file could not be read.");
    }
  }, []);

  async function cast() {
    if (!ballot || !key || !choice || signerIndex < 0 || !ballot.nodeUrl) return;
    setStage("casting");
    setResult(null);

    try {
      // The message is the canonical encoding of the three ids — never a free-form string, or the
      // signature would be replayable into another election or group.
      const message = encodeMessage({
        electionId: ballot.electionId,
        ringId: ballot.ringId,
        candidateId: choice,
      });

      const signature = sign({
        message,
        ring: ballot.publicKeys.map(fromBase64Url),
        signerIndex,
        privateKey: fromBase64Url(key.privateKey),
        electionId: ballot.electionId,
      });

      const response = await fetch(`${ballot.nodeUrl}/ballot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          electionId: ballot.electionId,
          ringId: ballot.ringId,
          candidateId: choice,
          signature: toBase64Url(serializeSignature(signature)),
        }),
      });

      const reply = (await response.text()).trim();
      if (reply === "OK") {
        saveVoteReceipt({
          electionId: ballot.electionId,
          electionTitle: ballot.electionTitle,
          candidateId: choice,
          candidateName: ballot.candidates.find((c) => c.id === choice)?.name ?? choice,
          nodeUrl: ballot.nodeUrl,
          keyImage: toBase64Url(signature.keyImage),
          castAt: new Date().toISOString(),
        });
        setResult({ ok: true, message: "Your ballot has been recorded on the ledger." });
        setStage("cast");
        return;
      }
      setResult({
        ok: false,
        message: NODE_REPLIES[reply] ?? `The ledger refused the ballot (${reply}).`,
      });
      setStage("ready");
    } catch {
      // Retryable: collecting the group again is allowed until the link expires.
      setResult({
        ok: false,
        message:
          "Could not reach the ledger. Check your connection and try again — nothing has been " +
          "recorded, and this link still works.",
      });
      setStage("ready");
    }
  }

  /* ── terminal states ─────────────────────────────────────────────────────────────────── */

  if (stage === "collecting") {
    return (
      <VoterShell kicker="Cast your ballot">
        <div className="px-6 py-8 text-[13px] text-ink/55">Collecting your ballot…</div>
      </VoterShell>
    );
  }

  if (error) {
    return (
      <VoterShell kicker="Cast your ballot">
        <div className="px-6 py-6">
          <Alert title="Cannot collect your ballot">{error}</Alert>
        </div>
      </VoterShell>
    );
  }

  if (stage === "cast" && result?.ok) {
    return (
      <VoterShell kicker="Ballot cast">
        <div className="px-6 py-6 flex flex-col gap-4">
          <Alert title="Your ballot has been cast">
            {result.message}
          </Alert>
          <div>
            <Label className="mb-2">Nobody else can look this up, and that is deliberate</Label>
            <p className="text-[12.5px] m-0">
              The ledger records that <em>someone</em> in your anonymity group voted for a
              candidate, and separately that your voting key has now been used — but nothing
              links the two to anyone watching. What you <em>can</em> do is confirm your own
              ballot was recorded correctly, because only you could have produced the key image
              that finds it. This browser has remembered it for you —{" "}
              <Link to="/verify" className="underline">
                verify your vote
              </Link>
              . Keep your key file regardless; do not use it again.
            </p>
          </div>
        </div>
      </VoterShell>
    );
  }

  if (!ballot) {
    return (
      <VoterShell kicker="Cast your ballot">
        <div className="px-6 py-6">
          <Alert title="Cannot collect your ballot">
            This page needs the ballot link from your email.
          </Alert>
        </div>
      </VoterShell>
    );
  }

  if (!ballot.nodeUrl) {
    return (
      <VoterShell kicker="Cast your ballot">
        <div className="px-6 py-6">
          <Alert title="Voting is not ready">
            No ledger has been recorded for this election yet, so there is nowhere to send a
            ballot. Contact the election office.
          </Alert>
        </div>
      </VoterShell>
    );
  }

  /* ── the ballot ──────────────────────────────────────────────────────────────────────── */

  const candidates = [...ballot.candidates].sort(
    (a, b) => a.ballotPosition - b.ballotPosition,
  );

  return (
    <VoterShell kicker="Cast your ballot">
      <div className="px-6 py-5 border-b-2 border-ink/40">
        <div className="font-extrabold text-[17px] leading-tight">{ballot.electionTitle}</div>
        <p className={`${hint} mt-1.5 mb-0`}>
          You are one of {ballot.publicKeys.length} voters in your anonymity group. Your ballot is
          signed on behalf of the whole group, so it proves you are entitled to vote without
          revealing which member you are.
        </p>
      </div>

      {result && !result.ok ? (
        <div className="px-6 pt-5">
          <Alert title="Ballot not accepted">{result.message}</Alert>
        </div>
      ) : null}

      {/* Step 1 — the key */}
      <div className="px-6 py-5 border-b border-ink/40">
        <Label className="mb-2">1 · Your voting key</Label>

        {key && signerIndex >= 0 ? (
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span className={mono}>{fingerprintOf(key.publicKey)}</span>
            <span className="text-[12px] text-ink/55">found in your group</span>
            <button
              type="button"
              className={`${btnSecondary} ml-auto`}
              onClick={() => {
                setKey(null);
                setChoice(null);
                setPasted("");
              }}
            >
              Use a different key
            </button>
          </div>
        ) : (
          <>
            <p className="text-[12.5px] mt-0 mb-3">
              Load the key file you downloaded when you registered — it is the only thing that can
              sign your ballot, and nobody else holds a copy.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".securepoll,.txt,text/plain"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void file.text().then(loadKeyText);
              }}
            />
            <button type="button" className={btn} onClick={() => fileInput.current?.click()}>
              Choose key file
            </button>

            <details className="mt-3.5">
              <summary className="text-[12.5px] cursor-pointer">
                Paste the key instead
              </summary>
              <textarea
                className={`${textarea} mt-2`}
                rows={3}
                placeholder="private_key: …"
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
              />
              <button
                type="button"
                className={btnSecondary}
                disabled={pasted.trim().length === 0}
                onClick={() => loadKeyText(pasted)}
              >
                Use this key
              </button>
            </details>

            {keyError ? (
              <div className="mt-3">
                <Alert title="That key cannot be used">{keyError}</Alert>
              </div>
            ) : null}

            {key && signerIndex < 0 ? (
              <div className="mt-3">
                <Alert title="This key is not in your group">
                  That key is valid, but it is not one of the {ballot.publicKeys.length} in the
                  group this link belongs to. It is probably from a different election, or a
                  replacement key issued after the group was frozen. Contact the election office.
                </Alert>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Step 2 — the choice */}
      <div className="px-6 py-5">
        <Label className="mb-2">2 · Your vote</Label>

        {key && signerIndex >= 0 ? (
          <>
            <div className="border-2 border-ink/40">
              {candidates.map((candidate) => (
                <label
                  key={candidate.id}
                  className={`flex items-center gap-3 px-4 py-3.5 border-b border-ink/40 last:border-b-0 cursor-pointer ${
                    choice === candidate.id ? "bg-surface" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="candidate"
                    value={candidate.id}
                    checked={choice === candidate.id}
                    onChange={() => setChoice(candidate.id)}
                  />
                  <span>
                    <span className="font-semibold text-[13.5px]">{candidate.name}</span>
                    {candidate.affiliation ? (
                      <span className="text-[12px] text-ink/55"> · {candidate.affiliation}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>

            <button
              type="button"
              className={`${btn} mt-4`}
              disabled={!choice || stage === "casting"}
              onClick={() => void cast()}
            >
              {stage === "casting" ? "Casting…" : "Cast ballot"}
            </button>
            <p className={`${hint} mt-2 mb-0`}>
              Once cast it cannot be changed or withdrawn, and it cannot be shown back to you.
            </p>
          </>
        ) : (
          <p className="text-[12.5px] text-ink/55 m-0">
            Load your voting key first.
          </p>
        )}
      </div>
    </VoterShell>
  );
}
