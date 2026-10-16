import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTxtMetadata, splitKeywords } from './metadata.ts';

test('keyword splitting handles the separators real sources use', () => {
  assert.deepEqual(splitKeywords('玄幻、都市 / 爽文'), ['玄幻', '都市', '爽文']);
  assert.deepEqual(splitKeywords('#重生 #系統'), ['重生', '系統']);
  assert.deepEqual(splitKeywords('【言情】，古代'), ['言情', '古代']);
  assert.deepEqual(splitKeywords(''), []);
});

test('keyword splitting drops duplicates and over-long words, and stays bounded', () => {
  assert.deepEqual(splitKeywords('武俠、武俠、仙俠'), ['武俠', '仙俠']);
  assert.deepEqual(splitKeywords(`短、${'長'.repeat(51)}`), ['短']);
  assert.equal(splitKeywords(Array.from({ length: 40 }, (_, i) => `t${i}`).join('、')).length, 20);
});

test('txt front matter yields category and tag suggestions alongside the other fields', () => {
  const metadata = extractTxtMetadata([
    '書名：長夜將盡', '作者：甲乙', '分類：玄幻、東方玄幻', '標籤：重生 / 系統', '狀態：連載中',
    '', '第一章 開端', '正文。',
  ].join('\n'));
  assert.equal(metadata.title, '長夜將盡');
  assert.equal(metadata.serialStatus, 'ongoing');
  assert.deepEqual(metadata.keywords, ['玄幻', '東方玄幻', '重生', '系統']);
});

test('english keyword fields are recognized and absent ones stay undefined', () => {
  assert.deepEqual(extractTxtMetadata('Title: Dusk\nGenre: fantasy, epic\n').keywords, ['fantasy', 'epic']);
  assert.deepEqual(extractTxtMetadata('Tags: slice-of-life\n').keywords, ['slice-of-life']);
  assert.equal(extractTxtMetadata('書名：無標註\n作者：甲\n').keywords, undefined);
});

test('a status field is still read as status, not as a keyword list', () => {
  const metadata = extractTxtMetadata('書名：甲\n連載狀態：已完結\n');
  assert.equal(metadata.serialStatus, 'completed');
  assert.equal(metadata.keywords, undefined);
});
