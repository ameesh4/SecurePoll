import type {
  ChainAdapter,
  ChainHealth,
  ElectionConfig,
  EncodedPublicKey,
  PublishResult,
} from "./types";

const NOT_IMPLEMENTED =
  "HttpChainAdapter is not implemented. The Rust node HTTP surface is owned by another " +
  "team and its routes are not settled; guessing them here would produce code that " +
  "compiles, appears to work against a stub, and fails on first contact with a real node.";

/**
 * TODO(blockchain-team): implement against the Rust nodes.
 *
 * Deliberately left throwing rather than sketched. Everything this class needs — route
 * paths, request and response shapes, auth between server and node, retry and quorum policy
 * when some of the nodes disagree — is the node team's decision, and inventing it would
 * bake a wrong contract into this side of the boundary.
 *
 * What is settled and should be honoured when it is written:
 *
 *  - `publishRing` must transmit the public keys in the order given. The ordering is part of
 *    what a signature verifies against; sorting or de-duplicating them breaks verification.
 *  - `getTally` and `getRejectedCount` are reads of the ledger's own state. Nothing they
 *    return may be written into this server's database.
 *  - `health` should probe every configured node and report how many answered, rather than
 *    returning the first success.
 */
export class HttpChainAdapter implements ChainAdapter {
  constructor(private readonly baseUrls: readonly string[]) {}

  async publishRing(
    _electionId: string,
    _ringId: string,
    _publicKeys: readonly EncodedPublicKey[],
  ): Promise<PublishResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async publishElectionConfig(_election: ElectionConfig): Promise<PublishResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getTally(_electionId: string): Promise<Record<string, number>> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getRejectedCount(_electionId: string): Promise<number> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async health(): Promise<ChainHealth> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
