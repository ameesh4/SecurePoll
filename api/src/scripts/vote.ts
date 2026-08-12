import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  derivePublicKey,
  encodeMessage,
  fromBase64Url,
  serializeSignature,
  sign,
  toBase64Url,
} from "../../../web/src/crypto/lrs";
import type { DemoTokenRecord } from "../lib/demoTokenStore";
import { logDemoVote } from "../lib/demoVoteLog";

/**
 * Demo voting client — casts real, LSAG-signed ballots without a browser.
 *
 * Replaces `blockchain/vote.py`, which cast votes against the pre-LSAG `/add_vote/<id>/<vote>`
 * endpoint and has not worked since ballots started requiring a real ring signature. This
 * script drives the exact same path a voter's browser does (`web/src/pages/VotePage.tsx`):
 * redeem a ballot-access token against the verification server, sign the canonical message
 * client-side, POST the signed ballot straight to the ledger node. The signing code is
 * imported from `web/src/crypto/lrs` rather than reimplemented — that library is the one
 * cross-language contract with the Rust verifier (WIRE_FORMAT.md), and a second copy here
 * would be a second thing that could drift out of sync with it.
 *
 * Tokens come from `api/demo-tokens/<electionId>/<voterId>.json`, written by
 * `rotateAndDeliver` (`ballotAccess.service.ts`) whenever a real token is minted — issue,
 * dispatch, retry, or resend. That file only exists outside production (`demoTokenStore.ts`).
 * Matching private keys come from `api/seed-keys/<email>.key`, written by
 * `db:seed-registrations`. A voter who registered for real through the browser has no key on
 * this server to sign with — by design (SECUREPOLL_CONTEXT.md §4 invariant 1) — so this can
 * only cast for seeded demo voters, never a real one.
 *
 * Usage:
 *   bun run vote --election <electionId> [--root-ip 0.0.0.0] [--root-port 8000]
 *                [--api http://localhost:5011/api/v1] [--delay-ms 250]
 */

const TOKEN_DIR = path.join(import.meta.dirname, "..", "..", "demo-tokens");
const KEY_DIR = path.join(import.meta.dirname, "..", "..", "seed-keys");

interface Args {
  electionId: string;
  apiBase: string;
  rootIp: string;
  rootPort: number;
  delayMs: number;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      flags[token.slice(2)] = "true";
    } else {
      flags[token.slice(2)] = value;
      i += 1;
    }
  }

  const electionId = flags.election;
  if (!electionId) {
    throw new Error(
      "Usage: bun run vote --election <electionId> [--root-ip 0.0.0.0] [--root-port 8000] " +
        "[--api http://localhost:5011/api/v1] [--delay-ms 250]",
    );
  }

  return {
    electionId,
    apiBase: (flags.api ?? "http://localhost:5011/api/v1").replace(/\/$/, ""),
    rootIp: flags["root-ip"] ?? "0.0.0.0",
    rootPort: Number(flags["root-port"] ?? 8000),
    delayMs: Number(flags["delay-ms"] ?? 250),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDemoTokens(electionId: string): DemoTokenRecord[] {
  const dir = path.join(TOKEN_DIR, electionId);
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map(
    (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as DemoTokenRecord,
  );
}

interface VoterKey {
  privateKey: string;
  publicKey: string;
}

/**
 * Reads back a key file in the same format `web/src/crypto/keys.ts#parseKeyFile` reads —
 * reimplemented locally only to avoid pulling that module's browser-only `downloadKeyFile`
 * (and the DOM types it needs) into this package. The actual cryptography, deriving and
 * comparing the public half, is the one shared implementation from `web/src/crypto/lrs`.
 */
function parseKeyFile(contents: string): VoterKey {
  const field = (label: string): string | null => {
    for (const line of contents.split(/\r?\n/)) {
      const [key, ...rest] = line.split(":");
      if (key?.trim() === label) return rest.join(":").trim();
    }
    return null;
  };

  const privateKey = field("private_key");
  if (!privateKey) throw new Error("no private_key line found in key file");

  const derived = toBase64Url(derivePublicKey(fromBase64Url(privateKey)));
  const stated = field("public_key");
  if (stated && stated !== derived) {
    throw new Error("key file is damaged: private and public halves do not match");
  }
  return { privateKey, publicKey: derived };
}

interface RingRetrieval {
  electionId: string;
  ringId: string;
  nodeUrl: string | null;
  publicKeys: string[];
  candidates: { id: string; name: string }[];
}

/** POSTs /ring, retrying on the endpoint's own rate limit rather than failing the whole run. */
async function fetchRing(apiBase: string, token: string): Promise<RingRetrieval> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(`${apiBase}/ring`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? 10);
      console.log(`  rate limited by /ring, waiting ${retryAfter}s (attempt ${attempt}/5)...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    const body = (await response.json()) as { data?: RingRetrieval; error?: { message: string } };
    if (!response.ok) {
      throw new Error(body.error?.message ?? `HTTP ${response.status}`);
    }
    if (!body.data) throw new Error("malformed response from /ring");
    return body.data;
  }
  throw new Error("gave up after repeated rate limiting on /ring");
}

/** What the node's plain-text reply means, in a demo-friendly phrase — mirrors VotePage.tsx. */
const NODE_REPLIES: Record<string, string> = {
  DOUBLE_VOTE: "already voted with this key",
  INVALID_SIGNATURE: "ledger rejected the signature",
  WRONG_ELECTION: "node serves a different election",
  UNKNOWN_RING: "node does not recognise this ring (manifest out of date?)",
  INVALID_CANDIDATE: "node does not recognise this candidate",
  MALFORMED_SIGNATURE: "ballot was not built correctly",
};

async function castOne(args: Args, record: DemoTokenRecord): Promise<{ ok: boolean; note: string }> {
  if (new Date(record.expiresAt) <= new Date()) {
    return { ok: false, note: "token expired" };
  }

  let keyFile: string;
  try {
    keyFile = readFileSync(path.join(KEY_DIR, `${record.deliverTo}.key`), "utf8");
  } catch {
    return { ok: false, note: `no seeded key file for ${record.deliverTo} (not a seeded voter)` };
  }
  const key = parseKeyFile(keyFile);

  const ring = await fetchRing(args.apiBase, record.token);

  const signerIndex = ring.publicKeys.indexOf(key.publicKey);
  if (signerIndex < 0) {
    return { ok: false, note: "this voter's key is not in the published ring" };
  }

  const candidate = ring.candidates[Math.floor(Math.random() * ring.candidates.length)];
  if (!candidate) return { ok: false, note: "election has no candidates" };

  const message = encodeMessage({
    electionId: ring.electionId,
    ringId: ring.ringId,
    candidateId: candidate.id,
  });
  const signature = sign({
    message,
    ring: ring.publicKeys.map(fromBase64Url),
    signerIndex,
    privateKey: fromBase64Url(key.privateKey),
    electionId: ring.electionId,
  });
  const encodedSignature = toBase64Url(serializeSignature(signature));

  const response = await fetch(`http://${args.rootIp}:${args.rootPort}/ballot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      electionId: ring.electionId,
      ringId: ring.ringId,
      candidateId: candidate.id,
      signature: encodedSignature,
    }),
  });
  const reply = (await response.text()).trim();

  if (reply === "OK") {
    logDemoVote({
      voterId: record.voterId,
      deliverTo: record.deliverTo,
      electionId: ring.electionId,
      candidateId: candidate.id,
      candidateName: candidate.name,
      keyImage: toBase64Url(signature.keyImage),
      castAt: new Date().toISOString(),
    });
    return { ok: true, note: `voted for "${candidate.name}"` };
  }
  return { ok: false, note: NODE_REPLIES[reply] ?? `ledger refused the ballot (${reply})` };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const records = loadDemoTokens(args.electionId);

  if (records.length === 0) {
    console.log(
      `No saved demo tokens for election ${args.electionId} under ${path.join(TOKEN_DIR, args.electionId)}.\n` +
        "Issue ballot access from the admin panel first (tokens are only saved outside production).",
    );
    return;
  }

  console.log(
    `Casting up to ${records.length} ballot(s) for election ${args.electionId} against ` +
      `http://${args.rootIp}:${args.rootPort}\n`,
  );

  let cast = 0;
  const skipped: string[] = [];

  for (const [index, record] of records.entries()) {
    process.stdout.write(`[${index + 1}/${records.length}] ${record.deliverTo}: `);
    try {
      const outcome = await castOne(args, record);
      console.log(outcome.note);
      if (outcome.ok) cast += 1;
      else skipped.push(`${record.deliverTo} — ${outcome.note}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`error — ${message}`);
      skipped.push(`${record.deliverTo} — ${message}`);
    }
    if (index < records.length - 1) await sleep(args.delayMs);
  }

  console.log(`\nCast ${cast}/${records.length}.`);
  if (skipped.length > 0) {
    console.log("Not cast:");
    for (const line of skipped) console.log(`  - ${line}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
