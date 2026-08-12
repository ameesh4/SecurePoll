import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env";

/**
 * Persists a plaintext ballot-access token to disk so `bun run vote` can cast a demo ballot
 * without a browser.
 *
 * This is a deliberate weakening of the real design, so it is scoped tightly:
 *
 *  - **Never in production.** The rest of the system guarantees a token's plaintext exists in
 *    exactly one place, the outbound email (`ballotAccess.service.ts`). A second durable copy
 *    is only acceptable for a local demo, the same reasoning that gives `ConsoleMailer` a
 *    production-only twin in `SmtpMailer`.
 *  - **One file per voter, overwritten on every mint.** `rotateAndDeliver` calls this at the
 *    exact point it replaces the token's hash in the database, so this file and the DB row can
 *    never disagree about which token is currently live — there is nothing here to go stale.
 *  - **Restrictive permissions**, matching the seed key files this sits alongside
 *    (`seedRegistrations.ts`), and a gitignored directory.
 */

const STORE_DIR = path.join(import.meta.dirname, "..", "..", "demo-tokens");

export interface DemoTokenRecord {
  voterId: string;
  electionId: string;
  /** The address the real email would have gone to — used to locate the matching seeded key file. */
  deliverTo: string;
  token: string;
  expiresAt: string;
}

export function saveDemoToken(record: DemoTokenRecord): void {
  if (env.NODE_ENV === "production") return;

  const dir = path.join(STORE_DIR, record.electionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${record.voterId}.json`), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
}
