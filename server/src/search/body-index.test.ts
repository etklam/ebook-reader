import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBodyIndex, bodyIndexMayContain } from './body-index.ts';
import { findChapterMatch } from './chapter-search.ts';
import { variantsForSearch } from './normalize.ts';
import { localStorage } from '../storage.ts';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('candidate filter never discards canonical matches including Unicode, whitespace and script variants', async () => {
  const body = 'HELLO\t  World。\n\n小龍出現了。\n\n😀山川河流\n\n[[img:' + 'a'.repeat(64) + ']]';
  const index = buildBodyIndex(body);
  for (const q of ['hello world', '小龙', '😀山川', '山川河流', 'HELLO', '不存在的搜尋詞']) {
    const variants = await variantsForSearch(q);
    if (findChapterMatch(body, '', variants)) assert.equal(bodyIndexMayContain(index, variants), true, q);
  }
  for (let i = 0; i < body.length - 3; i++) {
    const q = body.slice(i, i + 4).replace(/\s+/g, ' ').trim();
    if (findChapterMatch(body, '', [q])) assert.equal(bodyIndexMayContain(index, [q]), true, q);
  }
  assert.equal(bodyIndexMayContain(index, ['不存在的搜尋詞']), false);
});

test('corrupt and truncated indexes always admit canonical fallback', () => {
  const index = buildBodyIndex('小龍出現');
  index[index.length - 1] ^= 1;
  assert.equal(bodyIndexMayContain(index, ['missing']), true);
  assert.equal(bodyIndexMayContain(index.subarray(0, 10), ['missing']), true);
});

test('local indexes backfill, bypass short terms, detect missing bodies and clean up with the object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'body-index-'));
  try {
    const storage = localStorage(root);
    const key = await storage.put(Buffer.from('山川河流，繁花似錦。'), 'txt');
    assert.equal(await storage.searchCandidate!(key, ['不存在的搜尋詞']), false);
    assert.equal(await storage.searchCandidate!(key, ['山川']), true);
    await unlink(join(root, `${key}.sidx`));
    assert.equal(await storage.searchCandidate!(key, ['山川河流']), true);
    await writeFile(join(root, `${key}.sidx`), 'bad');
    assert.equal(await storage.searchCandidate!(key, ['不存在的搜尋詞']), true);
    await storage.delete(key); assert.deepEqual(await storage.list(), []);
    assert.equal(await storage.searchCandidate!(key, ['不存在的搜尋詞']), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
