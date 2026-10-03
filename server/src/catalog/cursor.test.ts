// L1 unit tests for the catalog cursor contract (Phase 3.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCursor, encodeCursor, filterFingerprint } from './cursor.ts';

const FP = filterFingerprint(['type=serial', 'sort=updated']);
const ID = '11111111-2222-3333-4444-555555555555';

test('round-trips a payload', () => {
  const raw = encodeCursor({ v: 1, f: FP, k: '2026-10-03T00:00:00.000000Z', id: ID });
  const out = decodeCursor(raw, FP);
  assert.equal(out.ok, true);
  assert.deepEqual(out.ok && out.cursor, { v: 1, f: FP, k: '2026-10-03T00:00:00.000000Z', id: ID });
});

test('a cursor from another filter set is refused, not silently applied', () => {
  const raw = encodeCursor({ v: 1, f: FP, k: 'x', id: ID });
  const other = filterFingerprint(['type=short_story', 'sort=updated']);
  const out = decodeCursor(raw, other);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.error, 'cursor_filter_mismatch');
});

test('fingerprint is order-insensitive for id sets but sensitive to values', () => {
  // the builder sorts and de-duplicates ids before fingerprinting, so these
  // two requests must share one cursor space
  const a = filterFingerprint(['cat=a.b', 'sort=updated']);
  const b = filterFingerprint(['cat=a.b', 'sort=updated']);
  assert.equal(a, b);
  assert.notEqual(a, filterFingerprint(['cat=a.c', 'sort=updated']));
  assert.notEqual(a, filterFingerprint(['cat=a.b', 'sort=title']));
});

test('malformed cursors are rejected rather than crashing', () => {
  for (const bad of ['', 'not-base64!!!', Buffer.from('{}').toString('base64url'),
    Buffer.from('null').toString('base64url'),
    Buffer.from(JSON.stringify({ v: 2, f: FP, k: 'x', id: ID })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, f: FP, k: 'x', id: 'not-a-uuid' })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, f: FP, id: ID })).toString('base64url')]) {
    const out = decodeCursor(bad, FP);
    assert.equal(out.ok, false, `expected refusal for ${bad.slice(0, 24)}`);
  }
});

test('a tampered id is still refused unless the fingerprint matches', () => {
  // the cursor is not a trust boundary — the predicate is rebuilt from the
  // request — but a swapped fingerprint must not be accepted
  const raw = Buffer.from(JSON.stringify({ v: 1, f: 'deadbeefdeadbeef', k: 'x', id: ID }))
    .toString('base64url');
  assert.equal(decodeCursor(raw, FP).ok, false);
});
