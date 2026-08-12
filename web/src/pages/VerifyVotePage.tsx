import { useEffect, useState } from "react";
import { Alert, Empty, Label } from "../components/primitives";
import { loadVoteReceipts, type VoteReceipt } from "../lib/voteReceipts";
import { btn, btnSecondary, field, hint, input, label, mono } from "../ui/classes";
import { VoterShell } from "./RegisterPage";

/**
 * Verifying a cast ballot.
 *
 * This does not — and cannot — let anyone browse the ledger for a particular voter's choice.
 * The lookup key is the key image, `I = x·H_p(P ‖ electionId)` (SECUREPOLL_CONTEXT.md §5.3): a
 * value only the person who signed with private key `x` could ever produce. Presenting it back
 * to a node *is* the proof that this is your own ballot, not someone else's. The node answers
 * with exactly what it already reveals to anyone via `/votes/tally` — a candidate id and a block
 * position — just addressed at one ballot instead of the whole count.
 */

interface VoteLookupResponse {
  electionId: string;
  found: boolean;
  candidateId: string | null;
  blockIndex: number | null;
  timestamp: number | null;
  blockHash: string | null;
}

type Status = "idle" | "checking";

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

export default function VerifyVotePage() {
  const [receipts, setReceipts] = useState<VoteReceipt[]>([]);
  const [nodeUrl, setNodeUrl] = useState("");
  const [keyImage, setKeyImage] = useState("");
  const [matchedReceipt, setMatchedReceipt] = useState<VoteReceipt | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VoteLookupResponse | null>(null);

  useEffect(() => {
    setReceipts(loadVoteReceipts());
  }, []);

  function selectReceipt(receipt: VoteReceipt) {
    setNodeUrl(receipt.nodeUrl);
    setKeyImage(receipt.keyImage);
    setMatchedReceipt(receipt);
    setResult(null);
    setError(null);
  }

  async function check() {
    if (!nodeUrl.trim() || !keyImage.trim()) return;
    setStatus("checking");
    setError(null);
    setResult(null);
    try {
      const base = nodeUrl.trim().replace(/\/+$/, "");
      const response = await fetch(`${base}/vote/${encodeURIComponent(keyImage.trim())}`);
      if (!response.ok) {
        setError(
          response.status === 400
            ? "That key image is not a valid base64url value."
            : `The ledger node returned an error (${response.status}).`,
        );
        return;
      }
      setResult((await response.json()) as VoteLookupResponse);
    } catch {
      setError(
        "Could not reach that ledger node. Check the address and your connection, then try again.",
      );
    } finally {
      setStatus("idle");
    }
  }

  return (
    <VoterShell kicker="Verify your vote">
      <div className="px-6 py-5 border-b-2 border-ink/40">
        <p className={`${hint} m-0`}>
          A key image proves only that you cast the ballot that produced it — the ledger cannot
          tell from it who you are, or which anonymity group you signed in. This page just asks
          the ledger node whether that key image was recorded, and what it recorded.
        </p>
      </div>

      <div className="px-6 py-5 border-b border-ink/40">
        <Label className="mb-2">Ballots this browser remembers</Label>
        {receipts.length === 0 ? (
          <Empty>No ballots have been cast from this browser.</Empty>
        ) : (
          <ul className="list-none m-0 p-0 border-2 border-ink/40">
            {receipts.map((receipt) => (
              <li
                key={receipt.keyImage}
                className="flex flex-wrap items-center gap-2.5 px-3.5 py-3 text-[12.5px] border-b border-ink/40 last:border-b-0"
              >
                <span className="font-semibold">{receipt.electionTitle}</span>
                <span className="text-ink/55">
                  voted {receipt.candidateName} · {new Date(receipt.castAt).toLocaleString()}
                </span>
                <button
                  type="button"
                  className={`${btnSecondary} ml-auto`}
                  onClick={() => selectReceipt(receipt)}
                >
                  Verify
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="px-6 py-5 border-b border-ink/40">
        <Label className="mb-2">Look up a key image</Label>
        <p className="text-[12.5px] mt-0 mb-3">
          On a different device, or if this browser's history was cleared, paste the ledger
          address and key image directly.
        </p>
        <div className="flex flex-col gap-3">
          <div className={field}>
            <label className={label} htmlFor="node-url">
              Ledger node address
            </label>
            <input
              id="node-url"
              className={input}
              placeholder="http://192.168.1.89:8000"
              value={nodeUrl}
              onChange={(event) => {
                setNodeUrl(event.target.value);
                setMatchedReceipt(null);
              }}
            />
          </div>
          <div className={field}>
            <label className={label} htmlFor="key-image">
              Key image
            </label>
            <input
              id="key-image"
              className={`${input} font-mono`}
              placeholder="base64url-encoded key image"
              value={keyImage}
              onChange={(event) => {
                setKeyImage(event.target.value);
                setMatchedReceipt(null);
              }}
            />
          </div>
        </div>
        <button
          type="button"
          className={`${btn} mt-4`}
          disabled={!nodeUrl.trim() || !keyImage.trim() || status === "checking"}
          onClick={() => void check()}
        >
          {status === "checking" ? "Checking…" : "Check the ledger"}
        </button>
      </div>

      {error ? (
        <div className="px-6 pt-5">
          <Alert title="Could not verify">{error}</Alert>
        </div>
      ) : null}

      {result ? (
        <div className="px-6 py-5">
          {result.found ? (
            <Alert title="Ballot found">
              <div className="flex flex-col gap-1.5">
                <div>
                  Recorded candidate:{" "}
                  <strong>
                    {matchedReceipt && matchedReceipt.candidateId === result.candidateId
                      ? matchedReceipt.candidateName
                      : result.candidateId}
                  </strong>
                </div>
                <div>Block position: {result.blockIndex}</div>
                {result.timestamp !== null ? (
                  <div>Recorded at: {formatTimestamp(result.timestamp)}</div>
                ) : null}
                {result.blockHash ? (
                  <div>
                    Block hash: <span className={mono}>{result.blockHash}</span>
                  </div>
                ) : null}
              </div>
            </Alert>
          ) : (
            <Alert title="No ballot found for that key image">
              This ledger node has no record of a vote with this key image. If you just voted,
              the node may still be mining your ballot — try again shortly.
            </Alert>
          )}
        </div>
      ) : null}
    </VoterShell>
  );
}
