import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { tidyTxt, DEFAULT_TIDY_OPTIONS } from './tidy-txt.ts';

test('wrapped prose joins while metadata, chapter labels and paragraph boundaries survive', () => {
  const source = '作品名：測試\n作者：甲\n狀態：完結\n\n第一章 開端\n錯誤斷行的句子\n接續文字。\n\n另一段文字。';
  const result = tidyTxt(source, { ...DEFAULT_TIDY_OPTIONS, joinWrappedLines: true });
  assert.equal(result.joinedLines, 1);
  assert.ok(result.text.startsWith('作品名：測試\n作者：甲\n狀態：完結\n\n第一章 開端\n'));
  assert.ok(result.text.endsWith('錯誤斷行的句子接續文字。\n\n另一段文字。'));
});

test('promotion removal supports both scripts and remains opt-in', () => {
  const source = '本書由測試網站整理\n本书由测试网站整理\n正文。';
  assert.equal(tidyTxt(source, DEFAULT_TIDY_OPTIONS).removedPromotionLines, 0);
  const result = tidyTxt(source, { ...DEFAULT_TIDY_OPTIONS, removePromotions: true });
  assert.equal(result.removedPromotionLines, 2);
  assert.equal(result.text, '正文。');
});
