import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/errors";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A deliberately small fixed-window limiter held in process memory. It exists to blunt
 * scripted abuse of the two unauthenticated endpoints — flooding the review queue with junk
 * registrations, and password guessing against admin login.
 *
 * In-memory means it resets on restart and does not coordinate across instances. That is
 * acceptable for a single-node deployment; a multi-node one needs this moved to Redis or
 * the database.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  name: string;
  /**
   * What to count against, defaulting to the caller's IP.
   *
   * Worth overriding on voter-facing endpoints. A college is exactly the deployment where a whole
   * campus shares one NAT'd address, so an IP bucket means one student's retries eat everybody
   * else's allowance. Keying on the record being acted upon limits abuse of *that* record without
   * making the endpoint unusable for the next person on the same wifi.
   */
  keyBy?: (req: Request) => string | undefined;
}) {
  const buckets = new Map<string, Bucket>();

  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const scope = options.keyBy?.(req) ?? req.ip ?? "unknown";
    const key = `${options.name}:${scope}`;

    // Sweeping on write keeps the map from growing without bound without needing a timer.
    if (buckets.size > 10_000) {
      for (const [existing, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(existing);
      }
    }

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", retryAfter);
      next(
        new AppError(429, "RATE_LIMITED", "Too many requests, please try again shortly", {
          retryAfter,
        }),
      );
      return;
    }

    next();
  };
}
