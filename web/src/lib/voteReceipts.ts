/**
 * Local record of ballots this browser has cast, keyed by key image.
 *
 * This is a convenience cache only, kept entirely client-side: the key image is a
 * deterministic function of the voter's own private key and the election id (§5.3), so it is
 * already safe for the voter to hold and present later — nothing here is a new secret. Losing
 * this (a cleared browser, a different device) does not lose the ability to verify: the same
 * key image can be recomputed from the voter's key file, and the verify page accepts it pasted
 * in directly.
 */

const STORAGE_KEY = "securepoll.vote-receipts";

export interface VoteReceipt {
  electionId: string;
  electionTitle: string;
  candidateId: string;
  candidateName: string;
  /** Root node of this election's ledger network — where `/vote/<keyImage>` is served. */
  nodeUrl: string;
  /** base64url-encoded key image, as sent to the ledger in the ballot signature. */
  keyImage: string;
  /** ISO timestamp of when this browser cast the ballot. */
  castAt: string;
}

export function loadVoteReceipts(): VoteReceipt[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Records a cast ballot. Replaces any existing entry for the same key image. */
export function saveVoteReceipt(receipt: VoteReceipt): void {
  try {
    const existing = loadVoteReceipts().filter((r) => r.keyImage !== receipt.keyImage);
    existing.push(receipt);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  } catch {
    // A private-browsing quota error or similar shouldn't block the voter from seeing their
    // "ballot cast" confirmation — the receipt is a convenience, not the vote itself.
  }
}
