// Uniform error surface (M7 hardening). Two problems this solves:
//
//  1. Hono's default onError returns the bare text "Internal Server Error" —
//     clients parsing JSON get a syntax error instead of a readable code.
//  2. An unhandled driver rejection printed the full failing SQL *and its bound
//     parameters* to stdout. Parameters routinely carry user ids, emails and
//     session hashes, so raw logging is a credential-leak path into whatever
//     ships the logs. We log a scrubbed summary instead.
//
// Bodies never include the message of an unexpected error: a Postgres error
// string can disclose schema, constraint and column names.
import type { Hono } from 'hono';

/** request-correlation id so a 500 body can be tied to one log line */
function errorRef(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface PgLike {
  code?: string;
  message?: string;
  query?: string;
  params?: unknown[];
  cause?: { code?: string; message?: string };
}

/** Postgres class 22/23 codes that are really malformed client input. */
const CLIENT_INPUT_CODES = new Set([
  '22P02', // invalid_text_representation — e.g. a non-UUID in a uuid column
  '22003', // numeric_value_out_of_range
  '22001', // string_data_right_truncation
]);

export function pgCodeOf(e: unknown): string | undefined {
  const err = e as PgLike | null;
  return err?.code ?? err?.cause?.code;
}

/** What is safe to put in a log line: never the query text or its parameters. */
export function scrubError(e: unknown): string {
  if (!(e instanceof Error)) return 'non-error thrown';
  const code = pgCodeOf(e);
  return code ? `${e.name}(pg:${code})` : `${e.name}: ${e.message}`;
}

export function installErrorHandlers(app: Hono<{ Variables: { userId: string; role: string } }>): void {
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    const code = pgCodeOf(err);

    // Malformed input that slipped past a route's own validation is a 400, not
    // a 500 — and it is not worth an error-level log line.
    if (code && CLIENT_INPUT_CODES.has(code)) {
      console.warn(`[warn] ${c.req.method} ${c.req.path} invalid_request pg:${code}`);
      return c.json({ error: 'invalid_request' }, 400);
    }

    const ref = errorRef();
    console.error(`[error] ref=${ref} ${c.req.method} ${c.req.path} ${scrubError(err)}`);
    return c.json({ error: 'internal_error', ref }, 500);
  });
}
