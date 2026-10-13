import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChapterMatch } from './chapter-search.ts';
import { variantsForSearch } from './normalize.ts';

test('book search preserves canonical paragraph indexes and literal Traditional/Simplified matches', async () => {
  const hash = 'a'.repeat(64);
  const body = `第一段\n\n[[img:${hash}|龍王的插圖]]\n\n小龍在這裡出現。\n\n再見小龍`;
  const found = findChapterMatch(body, '章名', await variantsForSearch('小龙'));
  assert.equal(found?.paragraphIndex, 2);
  assert.equal(found?.snippet.slice(found.matchStart, found.matchStart + found.matchLength), '小龍');
  assert.equal(findChapterMatch(body, '章名', [hash]), null);
  assert.equal(findChapterMatch(body, '章名', ['龍王']), null);
  assert.equal(findChapterMatch('內容', '小龍的故事', ['小龍'])?.paragraphIndex, 0);
  assert.equal(findChapterMatch('100% 完成 _ [a]', '', ['%'])?.matchLength, 1);
  assert.equal(findChapterMatch('100% 完成 _ [a]', '', ['.*']), null);
});

test('snippets locate earliest match and bound surrounding prose without changing target paragraph', () => {
  const body = `${'甲'.repeat(200)}小龍${'乙'.repeat(200)}另一个`;
  const found = findChapterMatch(`序\n\n${body}`, '', ['另一个', '小龍']);
  assert.ok(found);
  assert.equal(found.paragraphIndex, 1);
  assert.equal(found.snippet.slice(found.matchStart, found.matchStart + found.matchLength), '小龍');
  assert.ok(found.snippet.length <= 72 + 2 + 112 + 2);
});
