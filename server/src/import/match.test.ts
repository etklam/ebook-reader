import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchChapters, type ExistingChapter, type SourceItemRef } from './match.ts';
import { createHash } from 'node:crypto';

const h = (s: string) => createHash('sha256').update(s).digest('hex');

// helper: build existing chapters 1..n with body = `body-n`
function existingWork(n: number, bodyOf: (i: number) => string = (i) => `body-${i}`): ExistingChapter[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ex-${i + 1}`,
    labelRaw: `第${i + 1}章`,
    editorialPosition: i + 1,
    bodyCompareHash: h(bodyOf(i + 1)),
    title: '',
  }));
}
function src(labels: string[], bodyOf: (label: string, i: number) => string): SourceItemRef[] {
  return labels.map((labelRaw, i) => ({
    itemId: `s-${i}`,
    position: i,
    labelRaw,
    volumeLabel: null,
    bodyHash: h(bodyOf(labelRaw, i)),
    title: '',
  }));
}

test('IMP-02 shape: 1–190 vs 1–180 → 10 tail new (anchored), 4 modified kept, rest unchanged', () => {
  const existing = existingWork(180);
  const source = src(
    Array.from({ length: 190 }, (_, i) => `第${i + 1}章`),
    (label, i) => (i + 1 >= 101 && i + 1 <= 104 ? `revised-${i + 1}` : `body-${i + 1}`),
  );
  const r = matchChapters(existing, source);
  assert.equal(r.items.filter((o) => o.itemClass === 'unchanged').length, 176);
  assert.equal(r.items.filter((o) => o.itemClass === 'modified').length, 4);
  const news = r.items.filter((o) => o.itemClass === 'new');
  assert.equal(news.length, 10); // 181–190
  assert.ok(news.every((o) => o.positionConfident));
  assert.equal(r.missingFromSource.length, 0);
  assert.equal(r.needsReview, false);
});

test('IMP-04: 87.5 inserted between anchors 87 and 88', () => {
  const existing = existingWork(180);
  // 1–87, 87.5, 88–190: 191 logical chapters against the site's 1–180
  const source = src(
    Array.from({ length: 191 }, (_, i) => (i === 87 ? '第87.5章' : i < 87 ? `第${i + 1}章` : `第${i}章`)),
    (_l, i) => (i === 87 ? 'new-87.5' : i < 87 ? `body-${i + 1}` : `body-${i}`),
  );
  const r = matchChapters(existing, source);
  const mid = r.items.find((o) => o.labelRaw === '第87.5章')!;
  assert.equal(mid.itemClass, 'new');
  assert.equal(mid.insertAfterChapterId, 'ex-87');
  assert.equal(mid.insertBeforeChapterId, 'ex-88');
  assert.ok(mid.positionConfident);
  assert.equal(r.needsReview, false);
});

test('IMP-08: source 1–170 vs existing 1–180 → 171–180 kept as missing_from_source', () => {
  const existing = existingWork(180);
  const source = src(
    Array.from({ length: 170 }, (_, i) => `第${i + 1}章`),
    (_, i) => `body-${i + 1}`,
  );
  const r = matchChapters(existing, source);
  assert.equal(r.items.filter((o) => o.itemClass === 'unchanged').length, 170);
  assert.equal(r.missingFromSource.length, 10);
  assert.deepEqual(r.missingFromSource.map((m) => m.editorialPosition), [171, 172, 173, 174, 175, 176, 177, 178, 179, 180]);
  assert.equal(r.needsReview, false);
});

test('IMP-06: same label in two existing chapters → ambiguous, never cross-matched', () => {
  const existing: ExistingChapter[] = [
    { id: 'v1c5', labelRaw: '第5章', editorialPosition: 5, bodyCompareHash: h('a'), title: '' },
    { id: 'v2c5', labelRaw: '第5章', editorialPosition: 55, bodyCompareHash: h('b'), title: '' },
    { id: 'v1c6', labelRaw: '第6章', editorialPosition: 6, bodyCompareHash: h('c'), title: '' },
  ];
  const source = src(['第5章', '第6章'], (l) => (l === '第5章' ? 'a' : 'c'));
  const r = matchChapters(existing, source);
  const five = r.items.find((o) => o.labelRaw === '第5章')!;
  assert.equal(five.itemClass, 'ambiguous');
  assert.ok(five.reason.includes('duplicate_label_key'));
  assert.equal(r.items.find((o) => o.labelRaw === '第6章')!.itemClass, 'unchanged');
});

test('IMP-07: no anchors at all (standalone 181–190) → new, not position-confident, needs review', () => {
  const existing = existingWork(180);
  const source = src(
    Array.from({ length: 10 }, (_, i) => `第${181 + i}章`),
    (_, i) => `body-${181 + i}`,
  );
  const r = matchChapters(existing, source);
  assert.equal(r.items.filter((o) => o.itemClass === 'new').length, 10);
  assert.ok(r.items.every((o) => !o.positionConfident));
  assert.ok(r.needsReview);
  assert.ok(r.warnings.includes('no_matched_anchors'));
});

test('IMP-18 renamed: same body under a different label → ambiguous, not auto-match', () => {
  const existing = existingWork(3);
  const source = src(['第1章', '楔子二', '第3章'], (l) => (l === '楔子二' ? 'body-2' : l === '第1章' ? 'body-1' : 'body-3'));
  const r = matchChapters(existing, source);
  const renamed = r.items.find((o) => o.labelRaw === '楔子二')!;
  assert.equal(renamed.itemClass, 'ambiguous');
  assert.ok(renamed.reason.includes('body_match_label_differs'));
  assert.ok(r.needsReview);
});

test('IMP-18 renumbered: body belongs to a different existing chapter → structural_conflict', () => {
  // site 1..5; source relabels old bodies 1..5 as 2..6
  const existing = existingWork(5);
  const source = src(
    ['第2章', '第3章', '第4章', '第5章', '第6章'],
    (_, i) => `body-${i + 1}`, // source第2章 has body of existing 第1章
  );
  const r = matchChapters(existing, source);
  const shifted = r.items.filter((o) => o.itemClass === 'structural_conflict');
  assert.ok(shifted.length >= 4, `expected ≥4 conflicts, got ${shifted.map((o) => o.itemClass).join(',')}`);
  assert.ok(shifted.every((o) => o.reason.includes('body_belongs_to_other_chapter')));
});

test('IMP-18 split: two new chapters in a gap that still holds one unmatched chapter → structural_conflict', () => {
  const existing = existingWork(3);
  const source = src(
    ['第1章', '第2章（上）', '第2章（下）', '第3章'],
    (l) => (l === '第1章' ? 'body-1' : l === '第3章' ? 'body-3' : `part-${l}`),
  );
  const r = matchChapters(existing, source);
  for (const label of ['第2章（上）', '第2章（下）']) {
    const it = r.items.find((o) => o.labelRaw === label)!;
    assert.equal(it.itemClass, 'structural_conflict', label);
    assert.ok(it.reason.includes('span_count_mismatch'), label);
  }
});

test('partial 1–170 upload never leapfrogs: no new items, all matched', () => {
  const existing = existingWork(180);
  const source = src(['第179章', '第180章'], (_, i) => `body-${179 + i}`);
  const r = matchChapters(existing, source);
  assert.equal(r.items.filter((o) => o.itemClass === 'unchanged').length, 2);
  assert.equal(r.needsReview, false);
});

test('new tail items while site has later unmatched chapters → conflict, not silent leapfrog', () => {
  // site 1..5; source has 1,2 (matched) + unknown new before site's 4,5 unmatched
  const existing = existingWork(5);
  const source = src(['第1章', '第2章', '特別篇'], (l) => (l === '特別篇' ? 'extra' : `body-${l === '第1章' ? 1 : 2}`));
  const r = matchChapters(existing, source);
  const extra = r.items.find((o) => o.labelRaw === '特別篇')!;
  assert.equal(extra.itemClass, 'structural_conflict');
  assert.ok(extra.reason.includes('tail_over_existing_unmatched'));
});
