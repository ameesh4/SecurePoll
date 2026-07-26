/**
 * The only surface through which the verification server talks to the ledger.
 *
 * Everything on the far side of this interface is another team's code (Rust nodes) and out
 * of scope here. Keeping it to one narrow interface is not just tidiness: it is what makes
 * "the verification server never sees a ballot" checkable by reading a single file. Note
 * what is absent and must stay absent — there is no `submitVote`, no `getBallot`, no method
 * that takes a vote or returns one. Ballots travel from the voter's device straight to a
 * node; they do not pass through here.
 */

/**
 * A voter public key as this server stores and publishes it: a 32-byte compressed
 * ristretto255 point, base64url encoded, no padding.
 *
 * The project context sketched this parameter as `Point[]` (raw `Uint8Array`). Base64url is
 * used instead because it is what the database holds and what the ring published to the
 * ledger is transmitted as — decoding to bytes here only so the transport could re-encode
 * them would add a lossy round-trip and a second place for the encoding to be got wrong.
 * The bytes are identical either way; only the representation at this boundary differs.
 */
export type EncodedPublicKey = string;

/** Metadata a node needs in order to accept ballots for an election at all. */
export interface ElectionConfig {
  electionId: string;
  title: string;
  /** Candidate ids, which are what a ballot's signed message commits to. */
  candidateIds: readonly string[];
  votingOpensAt: Date;
  votingClosesAt: Date;
}

export interface ChainHealth {
  /** Nodes this server is configured to talk to. */
  nodes: number;
  /** How many of them answered the most recent probe. */
  reachable: number;
  /** Height of the longest chain the reachable nodes agree on. */
  height: number;
}

export interface PublishResult {
  /** Opaque handle the node returns, stored on the ring so publication is provable. */
  txRef: string;
}

export interface ChainAdapter {
  /**
   * Publishes one ring's ordered public keys. Order is part of the cryptographic contract —
   * a signature verifies against this exact sequence — so callers must not reorder.
   */
  publishRing(
    electionId: string,
    ringId: string,
    publicKeys: readonly EncodedPublicKey[],
  ): Promise<PublishResult>;

  publishElectionConfig(election: ElectionConfig): Promise<PublishResult>;

  /**
   * Per-candidate totals, keyed by candidate id. Read from the ledger and never cached in
   * this server's database: the tally is the ledger's fact, not ours, and storing it here
   * would create a second copy that could disagree.
   */
  getTally(electionId: string): Promise<Record<string, number>>;

  /**
   * How many submissions the ledger refused — a repeat key image, or a signature that did
   * not verify. A count only. Which voter, and what they voted, are both unknowable by
   * construction, and this method is not a way to find out.
   */
  getRejectedCount(electionId: string): Promise<number>;

  health(): Promise<ChainHealth>;
}
