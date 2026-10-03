// In-process sliding-window rate limiting (M7 hardening).
//
// Scope and honesty about it: this bounds abuse per API process. It is NOT a
// distributed limiter and not a DDoS defence — dev-plan §16 is explicit that
// volume control belongs at the edge/proxy. With more than one API replica the
// effective limit multiplies by the replica count, so the numbers below are
// deliberately strict enough to stay useful under that multiplication.
//
// Why login needs this at all: scrypt at N=16384 costs ~50-100 ms of CPU per
// attempt, so an unthrottled /api/auth/login is simultaneously an unlimited
// password-guessing oracle and a cheap CPU-exhaustion vector.
import type { Context, MiddlewareHandler } from 'hono';

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** seconds the caller should wait; 0 when allowed */
  retryAfter: number;
}

export interface RateLimiter {
  check(key: string): RateLimitVerdict;
  /** forget one bucket — used to credit a *successful* auth so a legitimate
   *  user who simply logs in often is never locked out by the attack limit */
  clear(key: string): void;
  /** test seam: drop all state */
  reset(): void;
  size(): number;
}

/**
 * Sliding window over per-key hit timestamps.
 *
 * Memory is bounded two ways: expired timestamps are dropped on access, and a
 * hard key ceiling evicts the least-recently-touched keys. Without the ceiling
 * an attacker rotating source addresses could grow the map without limit —
 * turning the mitigation into the memory-exhaustion bug it was meant to stop.
 */
export function createRateLimiter(rule: RateLimitRule, maxKeys = 10_000): RateLimiter {
  if (rule.max < 1) throw new Error('rate limit: max must be >= 1');
  if (rule.windowMs < 1) throw new Error('rate limit: windowMs must be >= 1');
  // Map preserves insertion order; re-inserting on touch makes it LRU-ordered.
  // `refusals` is the attack signal — see evict().
  interface Bucket { times: number[]; refusals: number }
  const hits = new Map<string, Bucket>();

  // Eviction order matters for correctness, not just memory. Dropping the
  // least-recently-used key unconditionally would let an attacker spray
  // throwaway keys (fake addresses, fake emails) until the victim's bucket was
  // evicted, resetting the very limit that was protecting them. So the order is
  // expired buckets, then never-refused buckets (fewest hits first), and only
  // as a last resort a bucket that has actually tripped the limit.
  const evict = (now: number): void => {
    for (const [key, bucket] of hits) {
      const live = bucket.times.filter((t) => now - t < rule.windowMs);
      if (live.length === 0 && bucket.refusals === 0) hits.delete(key);
      else hits.set(key, { times: live, refusals: bucket.refusals });
    }
    if (hits.size <= maxKeys) return;
    const ranked = [...hits.entries()].sort((a, b) =>
      (a[1].refusals - b[1].refusals) || (a[1].times.length - b[1].times.length));
    for (const [key] of ranked) {
      if (hits.size <= maxKeys) return;
      hits.delete(key);
    }
  };

  return {
    check(key) {
      const now = Date.now();
      const prior = hits.get(key);
      const times = (prior?.times ?? []).filter((t) => now - t < rule.windowMs);
      let refusals = prior?.refusals ?? 0;
      if (times.length >= rule.max) {
        refusals += 1;
        // keep the key hot so a sustained attacker is not evicted into a reset
        hits.delete(key);
        hits.set(key, { times, refusals });
        const oldest = times[0];
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((rule.windowMs - (now - oldest)) / 1000)) };
      }
      times.push(now);
      hits.delete(key);
      hits.set(key, { times, refusals });
      if (hits.size > maxKeys) evict(now);
      return { allowed: true, retryAfter: 0 };
    },
    clear(key) {
      hits.delete(key);
    },
    reset() {
      hits.clear();
    },
    size() {
      return hits.size;
    },
  };
}

/**
 * Caller address for limiting purposes.
 *
 * X-Forwarded-For is only read when the deployment explicitly says it sits
 * behind a trusted proxy. Reading it unconditionally would hand every client a
 * one-header bypass of every limit here, which is worse than no limit at all
 * because it looks protected.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // left-most entry is the original client; the proxy appends its own peer
    const fwd = c.req.header('x-forwarded-for');
    const first = fwd?.split(',')[0]?.trim();
    if (first) return first;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  /** limit bucket; `null` skips limiting for this request */
  keyOf: (c: Context) => string | null;
  errorCode: string;
}

export function rateLimit(opts: RateLimitMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    const key = opts.keyOf(c);
    if (key === null) return next();
    const verdict = opts.limiter.check(key);
    if (!verdict.allowed) {
      c.header('Retry-After', String(verdict.retryAfter));
      return c.json({ error: opts.errorCode, retryAfter: verdict.retryAfter }, 429);
    }
    await next();
  };
}
