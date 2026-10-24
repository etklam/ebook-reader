import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLabel, compareLabels, sameNumberCandidate } from './parse-label.ts';

test('parenthesized numbers retain their raw labels and share numeric candidate keys', () => {
  for (const raw of ['（十二）', '(十二)', '（１２）', '(012)']) {
    assert.equal(parseLabel(raw).raw, raw);
    assert.equal(parseLabel(raw).key, 'ch:12');
    assert.ok(sameNumberCandidate(parseLabel(raw), parseLabel('第12章')));
  }
  assert.equal(parseLabel('（一）（下）').key, 'ch:1#下');
  assert.equal(parseLabel('（註）').key, null);
});

test('plain chapter numbers', () => {
  assert.equal(parseLabel('第12章').key, 'ch:12');
  assert.equal(parseLabel('第1章 潮汐').key, 'ch:1');
});

test('decimal and multi-part labels are never numerically collapsed (ADR-01)', () => {
  const a = parseLabel('第12.10章');
  const b = parseLabel('第12.1章');
  assert.notEqual(a.key, b.key); // 12.10 is NOT 12.1
  assert.equal(parseLabel('第12.5章').key, 'ch:12.5');
  assert.notEqual(parseLabel('第12.5章').key, parseLabel('第12.50章').key); // trailing zero kept
  assert.equal(parseLabel('第12.5.1章').key, 'ch:12.5.1');
  assert.deepEqual(parseLabel('第12.5.1章').parts, ['12', '5', '1']);
});

test('raw label always preserved verbatim', () => {
  for (const raw of ['第012章', '第 12.5 章', '第12章（上）', '番外1.5', '風起']) {
    assert.equal(parseLabel(raw).raw, raw);
  }
});

test('leading zeros and width variants are candidate-equal, not identical', () => {
  assert.equal(parseLabel('第012章').key, 'ch:12');
  assert.equal(parseLabel('第１２章').key, 'ch:12'); // full-width digits
  assert.ok(sameNumberCandidate(parseLabel('第012章'), parseLabel('第12章')));
  assert.notEqual(parseLabel('第012章').raw, '第12章');
});

test('chinese numerals normalize for candidates only', () => {
  assert.equal(parseLabel('第十二章').key, 'ch:12');
  assert.equal(parseLabel('第一百二十三章').key, 'ch:123');
  assert.equal(parseLabel('第二千零五章').key, 'ch:2005');
  assert.ok(sameNumberCandidate(parseLabel('第十二章'), parseLabel('第12章')));
});

test('sub-parts 上/下 stay distinct', () => {
  const up = parseLabel('第12章（上）');
  const down = parseLabel('第12章（下）');
  assert.equal(up.subPart, '上');
  assert.equal(up.key, 'ch:12#上');
  assert.notEqual(up.key, down.key);
  assert.equal(parseLabel('第12章(下)').key, 'ch:12#下'); // half-width parens
});

test('special kinds: front / end / extra', () => {
  assert.equal(parseLabel('序章').kind, 'front');
  assert.equal(parseLabel('楔子').kind, 'front');
  assert.equal(parseLabel('終章').kind, 'end');
  assert.equal(parseLabel('番外1.5').kind, 'extra');
  assert.deepEqual(parseLabel('番外1.5').parts, ['1', '5'].slice(0, 2)); // ['1','5']
  assert.equal(parseLabel('番外1.5').key, 'extra:1.5');
  assert.equal(parseLabel('番外').kind, 'extra');
  assert.equal(parseLabel('番外三').key, 'extra:3');
});

test('unnumbered and unparseable labels are accepted, not rejected', () => {
  const p = parseLabel('風起');
  assert.equal(p.kind, 'unnumbered');
  assert.equal(p.parts, null);
  const q = parseLabel('第捌仟章'); // numeral we cannot parse
  assert.equal(q.parts, null); // numbered info null, chapter still acceptable
});

test('ordering: numeric per part, 12.5 < 12.9 < 12.10', () => {
  const seq = ['第12.5章', '第12.9章', '第12.10章', '第13章'].map(parseLabel);
  for (let i = 1; i < seq.length; i++) {
    assert.equal(compareLabels(seq[i - 1], seq[i]) < 0, true);
  }
  // insertion point for 87.5 is between 87 and 88 (IMP-04)
  assert.equal(compareLabels(parseLabel('第87章'), parseLabel('第87.5章')) < 0, true);
  assert.equal(compareLabels(parseLabel('第87.5章'), parseLabel('第88章')) < 0, true);
});

test('bare numeric labels and 第N回 marker', () => {
  assert.equal(parseLabel('12.5').key, 'ch:12.5');
  assert.equal(parseLabel('第3回').key, 'ch:3');
});

// Every bare-number heading form txt-parser can split on must also yield a
// numeric key: without one, re-importing the same book matches on title/body
// evidence instead of chapter number and inserts the whole book as new.
test('bare-number heading forms all share the plain chapter numbering key', () => {
  for (const label of ['（二）', '(2)', '（２）', '(二）', '（二)', '（ 二 ）',
    '【二】', '【 二 】', '〔二〕', '二、', '二 、', '其二', '第二章', '第2回']) {
    const p = parseLabel(label);
    assert.equal(p.key, 'ch:2', `${label} should key as ch:2`);
    assert.equal(p.kind, 'numbered', `${label} should be numbered`);
    assert.equal(p.raw, label, 'raw label is never rewritten');
  }
});

test('廿 and 卅 are whole tens, not digit-times-unit', () => {
  assert.equal(parseLabel('（廿）').key, 'ch:20');
  assert.equal(parseLabel('（廿一）').key, 'ch:21');
  assert.equal(parseLabel('（卅）').key, 'ch:30');
  assert.equal(parseLabel('（卅二）').key, 'ch:32');
  // the existing positional forms are unaffected
  assert.equal(parseLabel('第二十一章').key, 'ch:21');
});

test('crossing bracket types is not a numbering form', () => {
  for (const label of ['（二】', '【二）', '〔二)', '（註）', '【前言】']) {
    assert.equal(parseLabel(label).key, null, `${label} must not parse as a number`);
  }
});

// a70e306 kept both copies byte-identical by hand. This is the thing that
// notices when the next change only lands in one of them: m0/label-parser is
// the M0 reference implementation and server/src/import is what actually runs,
// so a number rule that differs between them is a silent correctness fork.
test('the M0 reference parser and the running parser stay identical', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    // the only sanctioned difference: the server copy names itself as canonical
    .replace(/^\/\/ Canonical copy for M2\+.*\n\/\/ archive stays untouched.*\n/m, '');
  assert.equal(read('./parse-label.ts'), read('../../../m0/label-parser/parse-label.ts'),
    'parse-label.ts drifted from m0/label-parser/parse-label.ts — apply the change to both');
});
