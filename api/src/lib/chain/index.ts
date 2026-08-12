import { HttpChainAdapter } from "./http";
import { InMemoryChainAdapter } from "./inMemory";
import type { ChainAdapter } from "./types";

export type {
  ChainAdapter,
  ElectionConfig,
  EncodedPublicKey,
  PublishResult,
} from "./types";
export { InMemoryChainAdapter } from "./inMemory";
export { HttpChainAdapter } from "./http";

/**
 * Which ledger an election talks to.
 *
 * Every election runs its **own separate blockchain network**, so there is no single ledger and
 * no module-level adapter. The election row carries the root node's address; an election without
 * one has no network yet and falls back to the in-memory stub, which is also what dev and tests
 * run against.
 *
 * Adapters are cached per address so repeated calls within a request do not rebuild them.
 */
export type ChainTarget = {
  chainRootIp: string | null;
  chainRootPort: number | null;
};

const httpAdapters = new Map<string, ChainAdapter>();
const devAdapter = new InMemoryChainAdapter();

export function chainFor(election: ChainTarget): ChainAdapter {
  if (!election.chainRootIp || election.chainRootPort === null) return devAdapter;

  const baseUrl = `http://${election.chainRootIp}:${election.chainRootPort}`;
  const existing = httpAdapters.get(baseUrl);
  if (existing) return existing;

  const adapter = new HttpChainAdapter([baseUrl]);
  httpAdapters.set(baseUrl, adapter);
  return adapter;
}

/** True when this election has a ledger network configured at all. */
export function hasChainConfigured(election: ChainTarget): boolean {
  return Boolean(election.chainRootIp) && election.chainRootPort !== null;
}
