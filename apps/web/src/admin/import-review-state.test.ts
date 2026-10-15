import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIdentity, needsDecision, reviewReason, reviewText } from './import-review-state.ts';

test('only conflicts and unanchored new source chapters block apply', () => {
  for (const itemClass of ['ambiguous', 'structural_conflict', 'new']) assert.equal(needsDecision({ kind: 'source', labelRaw: '', itemClass }), true);
  assert.equal(needsDecision({ kind: 'source', labelRaw: '', itemClass: 'new', positionConfident: true }), false);
  assert.equal(needsDecision({ kind: 'missing', labelRaw: '', itemClass: 'missing' }), false);
});
test('same reviewed payload retries use same idempotency key, a changed plan gets another', () => {
  const first = applyIdentity(null, 'plan-a', () => 'first');
  assert.equal(applyIdentity(first, 'plan-a', () => 'wrong'), first);
  assert.deepEqual(applyIdentity(first, 'plan-b', () => 'second'), { payload: 'plan-b', key: 'second' });
  assert.equal(reviewText(`文字[[img:${'b'.repeat(64)}]]`), '文字〔圖片 bbbbbbbbbbbb〕');
  assert.equal(reviewText(`文字[[img:${'b'.repeat(64)}|插圖說明]]`), '文字〔圖片 bbbbbbbbbbbb〕');
});

test('review reasons explain matching evidence without exposing implementation codes', () => {
  assert.equal(reviewReason('duplicate_label_key'), '來源或站方有重複章號，需人工確認');
  assert.equal(reviewReason('future_engine_code'), '需人工核對章節身分與來源順序');
});
