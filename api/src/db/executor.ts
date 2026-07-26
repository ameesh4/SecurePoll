import type { db } from "./drizzle";

/**
 * Either the pooled client or an open transaction. Repositories take one of these so a
 * service can compose several of them inside a single transaction without the repository
 * needing to know whether it is in one.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
