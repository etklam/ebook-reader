import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChapterLoader } from './chapter-loader.ts';

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
