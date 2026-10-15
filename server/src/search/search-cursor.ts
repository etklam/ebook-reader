import { filterFingerprint } from '../catalog/cursor.ts';

interface SearchCursor { v: 1; f: string; r: string; n: number; s: number; check: string }
const checksum = (cursor: Omit<SearchCursor, 'check'>) =>
  filterFingerprint([String(cursor.v), cursor.f, cursor.r, String(cursor.n), String(cursor.s)]);

export function encodeSearchCursor(filter: string, revision: string, next: number, shown: number): string {
  const value = { v: 1 as const, f: filter, r: revision, n: next, s: shown };
  return Buffer.from(JSON.stringify({ ...value, check: checksum(value) })).toString('base64url');
}

// The checksum detects corrupt cursors; it is not authorization. Each request
// rebuilds the authorized version and only indexes its own metadata rows.
export function decodeSearchCursor(raw: string, filter: string, revision: string, length: number):
  | { ok: true; next: number; shown: number }
  | { ok: false; status: 400 | 409; error: string } {
  const invalid = { ok: false as const, status: 400 as const, error: 'invalid_cursor' };
  if (raw.length > 2048) return invalid;
  let value: Partial<SearchCursor> | null;
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { return invalid; }
  if (!value || value.v !== 1 || typeof value.f !== 'string' || typeof value.r !== 'string'
    || !Number.isSafeInteger(value.n) || !Number.isSafeInteger(value.s)
    || value.n! < 0 || value.s! < 0
    || value.check !== checksum(value as SearchCursor)) return invalid;
  if (value.f !== filter) return { ok: false, status: 400, error: 'cursor_filter_mismatch' };
  if (value.r !== revision) return { ok: false, status: 409, error: 'search_version_changed' };
  if (value.n! >= length || value.s! > length) return invalid;
  return { ok: true, next: value.n!, shown: value.s! };
}
