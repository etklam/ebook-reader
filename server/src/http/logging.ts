// Structured request logging (M7 Phase 4).
//
// Replaces Hono's dev logger, which printed two human-readable lines per
// request. For Beta we need lines a log shipper can parse and correlate: one
// JSON object per request, carrying the same `ref` that a 500 response body
// returns so a user's report ("I got error ref a1b2c3d4") maps to exactly one
// line.
//
// What is deliberately NOT logged:
//   - the query string. Nothing secret travels there today, but logs outlive
//     the code that writes them and a future `?token=` would be captured
//     forever. The path and a boolean are enough to debug a route.
//   - request/response bodies, cookies, and the Authorization header.
//   - the client address by default: it is personal data, and a reading site
//     does not need a per-request location trail to operate. LOG_CLIENT_IP
//     turns it on for incident response.
import type { MiddlewareHandler } from 'hono';
import { randomBytes } from 'node:crypto';
import { clientIp } from './rate-limit.ts';

export interface RequestLogOptions {
  /** include the caller's address; off by default (personal data) */
  logClientIp: boolean;
  trustProxy: boolean;
  /** paths to skip entirely — health probes would otherwise dominate the log */
  skip?: readonly string[];
}

export function newRequestRef(): string {
  return randomBytes(4).toString('hex');
}

// The correlation id is stored on the context under this key. It is read and
// written through the helpers below rather than by widening the app's
// Variables type: every route module declares `{ userId, role }`, and adding a
// third property to the parent app makes those modules non-assignable (Hono's
// Variables are invariant). A runtime key with narrow accessors keeps the
// module boundaries unchanged.
const REF_KEY = 'ref';

type RefCarrier = {
  set(key: string, value: string): void;
  get(key: string): unknown;
};

export function setRequestRef(c: unknown, ref: string): void {
  (c as RefCarrier).set(REF_KEY, ref);
}

export function getRequestRef(c: unknown): string | undefined {
  const v = (c as RefCarrier).get(REF_KEY);
  return typeof v === 'string' ? v : undefined;
}

export function requestLogger(opts: RequestLogOptions): MiddlewareHandler {
  const skip = new Set(opts.skip ?? ['/healthz', '/readyz']);
  return async (c, next) => {
    if (skip.has(c.req.path)) return next();
    const ref = newRequestRef();
    setRequestRef(c, ref);
    const started = process.hrtime.bigint();
    try {
      await next();
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const line: Record<string, unknown> = {
        t: new Date().toISOString(),
        lvl: c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info',
        ref,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(ms * 10) / 10,
        // whether a query was present, without recording what it was
        q: c.req.url.includes('?') || undefined,
        // role rather than user id: enough to tell admin traffic from member
        // traffic when reading logs, without building a per-user activity trail
        role: c.get('role') || undefined,
      };
      if (opts.logClientIp) line.ip = clientIp(c, opts.trustProxy);
      console.log(JSON.stringify(line));
    }
  };
}
