import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env";

/**
 * Appends a demo-only record of which seeded voter cast which vote.
 *
 * This is `bun run vote` writing down what it already knows about itself — it drives each
 * seeded demo voter through their own key file one at a time (see `scripts/vote.ts`), so the
 * identity and the choice are already sitting in the same stack frame. This just lets a demo
 * run be sanity-checked against the ledger's own tally afterward.
 *
 * It must never run in production: the real path (a voter's own browser signing in
 * `VotePage.tsx`, straight to a ledger node) never brings identity and candidate together
 * anywhere this server can see, and that invariant does not get an exception for demos.
 */

const STORE_DIR = path.join(import.meta.dirname, "..", "..", "demo-tokens");

export interface DemoVoteRecord {
  voterId: string;
  /** The seeded voter's email — same field `DemoTokenRecord.deliverTo` uses. */
  deliverTo: string;
  electionId: string;
  candidateId: string;
  candidateName: string;
  /** base64url-encoded key image the ballot was signed with. */
  keyImage: string;
  castAt: string;
}

export function logDemoVote(record: DemoVoteRecord): void {
  if (env.NODE_ENV === "production") return;

  const dir = path.join(STORE_DIR, record.electionId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, "cast-votes.jsonl"), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}
