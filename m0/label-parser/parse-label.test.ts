import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabel, compareLabels, sameNumberCandidate } from './parse-label.ts';

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
