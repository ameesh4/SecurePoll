import type {
  ChainAdapter,
  ElectionConfig,
  EncodedPublicKey,
  PublishResult,
} from "./types";

const NOT_PUSHED =
  "Publishing to the ledger over HTTP is not how this system distributes an election. The " +
  "admin panel exports an election manifest (GET /admin/elections/:id/chain-manifest) and " +
  "each node imports it from disk. See blockchain/ELECTION_MANIFEST.md.";

/**
 * Reads an election's ledger over HTTP.
 *
 * **Reads are implemented; writes are not, by design.** Under the file-based manifest flow
 * nothing is pushed to a node — the admin exports a manifest and each node imports it — so
 * `publishRing` and `publishElectionConfig` throw rather than inventing a push protocol that
 * would duplicate the manifest as a second, divergent source of truth.
 *
 * Two rules the reads honour:
 *
 *  - `getTally` and `getRejectedCount` are reads of the ledger's own state. Nothing they return
 *    may be written into this server's database: the tally is the ledger's fact, not ours, and a
 *    stored copy could disagree.
 *  - Every read confirms the node serves the election being asked about, in the same response as
 *    the figure itself. One adapter instance is cached per address, and an address can be wrong.
 */
export class HttpChainAdapter implements ChainAdapter {
  constructor(private readonly baseUrls: readonly string[]) {}

  async publishRing(
    _electionId: string,
    _ringId: string,
    _publicKeys: readonly EncodedPublicKey[],
  ): Promise<PublishResult> {
    throw new Error(NOT_PUSHED);
  }

  async publishElectionConfig(_election: ElectionConfig): Promise<PublishResult> {
    throw new Error(NOT_PUSHED);
  }


  /**
   * `GET /votes/tally` — per-candidate totals keyed by `candidateId`.
   *
   * The election id is not sent in the request: a node serves exactly one election, named in the
   * manifest it imported, so the node's address already selects the election. But an address can
   * be wrong, so the node echoes its own `electionId` in the response and `read` refuses any
   * answer that does not match. Without that check, an election pointed at the wrong network
   * would display another election's result as its own, silently.
   */
  async getTally(electionId: string): Promise<Record<string, number>> {
    const body = await this.read("/votes/tally", electionId);
    const tally = body.tally;
    if (!tally || typeof tally !== "object") return {};

    const result: Record<string, number> = {};
    for (const [candidateId, count] of Object.entries(tally)) {
      if (typeof count === "number" && Number.isFinite(count)) result[candidateId] = count;
    }
    return result;
  }

  async getRejectedCount(electionId: string): Promise<number> {
    const body = await this.read("/votes/rejected", electionId);
    return typeof body.rejected === "number" && Number.isFinite(body.rejected)
      ? body.rejected
      : 0;
  }

  /**
   * Reads a node endpoint and refuses the answer unless the node confirms it serves the election
   * being asked about.
   *
   * The confirmation travels in the same response as the figure, rather than being a separate
   * "which election are you?" call — otherwise the answer and the data could describe different
   * things, and a node restarted onto a different manifest in between would go unnoticed.
   */
  private async read(
    path: string,
    expectedElectionId: string,
  ): Promise<Record<string, unknown>> {
    const base = this.baseUrls[0];
    if (!base) throw new Error("No ledger node is configured for this election");

    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
    } catch (error) {
      throw new Error(
        `Ledger node at ${base} did not respond: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      throw new Error(`Ledger node at ${base} returned ${response.status} for ${path}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    if (body.electionId !== expectedElectionId) {
      throw new Error(
        `Ledger node at ${base} serves election ${String(body.electionId)}, not ` +
          `${expectedElectionId}. Check this election's ledger root address — reading on would ` +
          `report another election's figures as this one's.`,
      );
    }
    return body;
  }
}
