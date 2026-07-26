import { randomBytes } from "crypto";
import type {
  ChainAdapter,
  ChainHealth,
  ElectionConfig,
  EncodedPublicKey,
  PublishResult,
} from "./types";

/**
 * Development and test implementation. Holds published rings in process memory and invents
 * a plausible chain height so the monitoring screen has something to render.
 *
 * The tally it returns is fabricated. That is safe here precisely because of the property
 * the real system is built around: this server has no ballots to tally, so there is nothing
 * a stub could get *wrong* — it is standing in for a foreign system's answer, not
 * approximating our own data.
 */
export class InMemoryChainAdapter implements ChainAdapter {
  private readonly rings = new Map<string, readonly EncodedPublicKey[]>();
  private readonly configs = new Map<string, ElectionConfig>();
  private height = 84_000;

  private advance(): string {
    this.height += 1;
    return `mem:${randomBytes(8).toString("hex")}`;
  }

  async publishRing(
    electionId: string,
    ringId: string,
    publicKeys: readonly EncodedPublicKey[],
  ): Promise<PublishResult> {
    this.rings.set(`${electionId}/${ringId}`, [...publicKeys]);
    return { txRef: this.advance() };
  }

  async publishElectionConfig(election: ElectionConfig): Promise<PublishResult> {
    this.configs.set(election.electionId, election);
    return { txRef: this.advance() };
  }

  async getTally(electionId: string): Promise<Record<string, number>> {
    const config = this.configs.get(electionId);
    if (!config) return {};

    // Spread deterministically across candidates rather than randomly, so a reloaded
    // monitoring screen does not appear to change the result of an election.
    const tally: Record<string, number> = {};
    config.candidateIds.forEach((candidateId, index) => {
      tally[candidateId] = 40 + ((index * 37) % 120);
    });
    return tally;
  }

  async getRejectedCount(_electionId: string): Promise<number> {
    return 0;
  }

  async health(): Promise<ChainHealth> {
    return { nodes: 7, reachable: 7, height: this.height };
  }
}
