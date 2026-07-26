import { InMemoryChainAdapter } from "./inMemory";
import type { ChainAdapter } from "./types";

export type {
  ChainAdapter,
  ChainHealth,
  ElectionConfig,
  EncodedPublicKey,
  PublishResult,
} from "./types";
export { InMemoryChainAdapter } from "./inMemory";
export { HttpChainAdapter } from "./http";

/**
 * The in-memory stub is the only usable implementation today. When the node team's HTTP
 * surface lands, select it here from configuration — the rest of the codebase reaches the
 * ledger only through `chain`, so nothing else has to change.
 */
export const chain: ChainAdapter = new InMemoryChainAdapter();
