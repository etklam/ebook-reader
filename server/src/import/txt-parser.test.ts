import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseTxt } from './txt-parser.ts';

const FIXTURES = fileURLToPath(new URL('../../../m0/fixtures/txt', import.meta.url));

test('base-180: exactly 180 ordered chapters with raw labels', () => {
  const text = readFileSync(join(FIXTURES, 'base-180.txt'), 'utf8');
  const { chapters, warnings } = parseTxt(text);
  assert.equal(chapters.length, 180);
  assert.equal(warnings.length, 0);
  assert.equal(chapters[0].labelRaw, '第1章');
  assert.equal(chapters[0].title, '起風');
  assert.equal(chapters[179].labelRaw, '第180章');
  assert.equal(chapters[0].position, 0);
  assert.equal(chapters[179].position, 179);
  assert.ok(chapters[0].body.length > 0);
  assert.ok(chapters.every((c) => c.parsed?.kind === 'numbered'));
});

test('weird-labels: labels survive verbatim, no numeric coercion', () => {
  const text = readFileSync(join(FIXTURES, 'weird-labels.txt'), 'utf8');
  const { chapters } = parseTxt(text);
  const labels = chapters.map((c) => c.labelRaw);
  // 10 headings in the fixture: 序章, 12.5, 12.10, 12.5.1, 12上, 12下, 012, 番外1.5, 風起(bare), 終章
  assert.deepEqual(labels, [
    '序章', '第12.5章', '第12.10章', '第12.5.1章', '第12章（上）',
    '第12章（下）', '第012章', '番外1.5', '風起', '終章',
  ]);
  // 12.10 must keep its trailing zero and stay distinct from 12.1
  const ch1210 = chapters.find((c) => c.labelRaw === '第12.10章')!;
  assert.equal(ch1210.parsed?.parts?.join('.'), '12.10');
  assert.equal(ch1210.parsed?.key, 'ch:12.10');
  const ch1251 = chapters.find((c) => c.labelRaw === '第12.5.1章')!;
  assert.deepEqual(ch1251.parsed?.parts, ['12', '5', '1']);
  const subUp = chapters.find((c) => c.labelRaw === '第12章（上）')!;
  assert.equal(subUp.parsed?.subPart, '上');
  // non-numeric labels parse as their kinds
  assert.equal(chapters[0].parsed?.kind, 'front');
  assert.equal(chapters.find((c) => c.labelRaw === '番外1.5')!.parsed?.kind, 'extra');
  assert.equal(chapters.find((c) => c.labelRaw === '風起')!.parsed?.kind, 'unnumbered');
  // duplicate labels would survive (none in this fixture, but none flagged)
  assert.ok(chapters.every((c) => !c.warnings.includes('duplicate_label')));
});

test('duplicate raw labels are preserved with a warning', () => {
  const text = '第1章 甲\n\n內容一。\n\n第1章 甲\n\n內容二。\n\n第2章 乙\n\n內容三。';
  const { chapters } = parseTxt(text);
  assert.deepEqual(chapters.map((c) => c.labelRaw), ['第1章', '第1章', '第2章']);
  assert.ok(chapters[1].warnings.includes('duplicate_label'));
});

test('prose mentioning 第十二章 inside a paragraph is not a boundary', () => {
  const text = [
    '第1章 起', '', '他在信裡提到第十二章的舊事，第12.5章的手稿也不見了。', '',
    '第2章 承', '', '後續。',
  ].join('\n');
  const { chapters } = parseTxt(text);
  assert.equal(chapters.length, 2);
  assert.ok(chapters[0].body.includes('第十二章的舊事'));
});

test('no headings: whole file becomes one review-flagged section, nothing lost', () => {
  const text = '這是一段沒有章節標題的長文。\n\n第二段也在同一章。\n\n第三段。';
  const { chapters, warnings } = parseTxt(text);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].labelRaw, '');
  assert.ok(chapters[0].body.includes('第二段也在同一章'));
  assert.equal(chapters[0].needsReview, true);
  assert.ok(warnings.includes('no_reliable_chapter_boundaries'));
});

test('content before the first heading is kept and flagged', () => {
  const text = '楔子之前多出來的文字。\n\n第1章 甲\n\n正文。';
  const { chapters } = parseTxt(text);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].labelRaw, '');
  assert.ok(chapters[0].warnings.includes('leading_content_before_first_heading'));
  assert.ok(chapters[0].body.includes('多出來的文字'));
});

test('volume lines set volume label and do not become chapters', () => {
  const text = '第一卷\n\n第1章 甲\n\n文。\n\n第二卷\n\n第2章 乙\n\n文。';
  const { chapters } = parseTxt(text);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].volumeLabel, '第一卷');
  assert.equal(chapters[1].volumeLabel, '第二卷');
});

test('87.5 insertion chapter parses with multi-part number', () => {
  const text = readFileSync(join(FIXTURES, 'full-190.txt'), 'utf8');
  const { chapters } = parseTxt(text);
  // fixture layout: 1–86, 87.5, 88–190 → 190 items total (87.5 sits mid-file)
  assert.equal(chapters.length, 190);
  const ins = chapters.find((c) => c.labelRaw === '第87.5章')!;
  assert.equal(ins.parsed?.parts?.join('.'), '87.5');
  assert.equal(chapters[85].labelRaw, '第86章');
  assert.equal(chapters[86].labelRaw, '第87.5章');
  assert.equal(chapters[87].labelRaw, '第88章');
});
