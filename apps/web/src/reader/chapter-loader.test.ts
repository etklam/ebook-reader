import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChapterLoader, shouldPrefetchNext } from './chapter-loader.ts';

test('next chapter navigation reuses pending preload once, later revisits fetch fresh', async () => {
  let calls = 0;
  let resolve!: (value: string) => void;
  const loader = createChapterLoader(() => { calls++; return new Promise<string>((r) => { resolve = r; }); });
  loader.prefetch('next'); loader.prefetch('next');
  const result = loader.load('next');
  assert.equal(calls, 1);
  resolve('body'); assert.equal(await result, 'body');
  void loader.load('next'); assert.equal(calls, 2);
});

test('failed preload retries and expired preload is not used', async () => {
  let time = 0;
  let calls = 0;
  const loader = createChapterLoader(async () => { if (++calls === 1) throw new Error('offline'); return calls; }, () => time);
  loader.prefetch('next'); await Promise.resolve();
  assert.equal(await loader.load('next'), 2);
  loader.prefetch('next'); time = 30_001;
  assert.equal(await loader.load('next'), 4);
  loader.prefetch(null); assert.equal(calls, 4);
});

test('prefetch waits for 80% or final two pages, short chapters trigger immediately', () => {
  const position = { scrollTop: 0, scrollHeight: 5000, viewportHeight: 800, page: 0, pageCount: 20 };
  assert.equal(shouldPrefetchNext('scroll', position), false);
  assert.equal(shouldPrefetchNext('scroll', { ...position, scrollTop: 3360 }), true);
  assert.equal(shouldPrefetchNext('scroll', { ...position, scrollHeight: 850 }), true);
  assert.equal(shouldPrefetchNext('scroll', { ...position, viewportHeight: 0 }), false);
  assert.equal(shouldPrefetchNext('paginated', position), false);
  assert.equal(shouldPrefetchNext('paginated', { ...position, page: 18 }), true);
  assert.equal(shouldPrefetchNext('paginated', { ...position, pageCount: 2 }), true);
});

test('clearing an instance discards even pending preloads after page/auth context leaves', async () => {
  let calls = 0;
  const loader = createChapterLoader(async () => ++calls);
  loader.prefetch('next'); loader.clear();
  assert.equal(await loader.load('next'), 2);
});

test('publication validation rejects stale cached text and rechecks access before consumption', async () => {
  let calls = 0;
  let valid = false;
  const loader = createChapterLoader(async () => ++calls, Date.now, async () => valid);
  loader.prefetch('next');
  assert.equal(await loader.load('next'), 2);
  valid = true;
  loader.prefetch('next');
  assert.equal(await loader.load('next'), 3);
  const inaccessible = createChapterLoader(async () => 'private', Date.now, async () => { throw new Error('forbidden'); });
  inaccessible.prefetch('next');
  await assert.rejects(inaccessible.load('next'), /forbidden/);
});
