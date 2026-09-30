// Reader unit tests (M5 §21.1): paragraph splitting, settings normalization,
// revision remap, pagination helpers, conversion paragraph invariance.
// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// reader-state touches localStorage inside functions; provide a stub before import
interface Store { [k: string]: string }
const mem: Store = {};
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { splitParagraphs } = await import('./paragraphs.ts');
const { normalizeSettings, remapPosition, loadPosition, savePosition, loadSettings, DEFAULT_SETTINGS } = await import('./reader-state.ts');
const { clampPage, pageStep, debounce } = await import('./pagination.ts');
const { convertParagraphs } = await import('./conversion.ts');

// --- paragraphs -------------------------------------------------------------------
test('splitParagraphs: canonical \\n\\n contract, empty body → []', () => {
  assert.deepEqual(splitParagraphs(''), []);
  assert.deepEqual(splitParagraphs('第一段'), ['第一段']);
  assert.deepEqual(splitParagraphs('一\n\n二\n\n三'), ['一', '二', '三']);
  // single \n inside a paragraph stays within it
  assert.deepEqual(splitParagraphs('一\n二'), ['一\n二']);
  assert.equal(splitParagraphs('一\n\n\n\n二').length, 3); // blank paragraph is legal
});

// --- settings ----------------------------------------------------------------------
test('normalizeSettings: garbage input falls back to defaults (no NaN)', () => {
  const s = normalizeSettings({ fontSize: 'abc', lineHeight: undefined, paragraphSpacing: null });
  assert.equal(s.fontSize, DEFAULT_SETTINGS.fontSize);
  assert.equal(s.lineHeight, DEFAULT_SETTINGS.lineHeight);
  assert.equal(s.paragraphSpacing, DEFAULT_SETTINGS.paragraphSpacing);
  assert.equal(s.mode, 'scroll');
  assert.equal(s.conversion, 'original');
  assert.equal(Number.isNaN(s.paragraphSpacing), false);
});

test('normalizeSettings: clamps out-of-range values, keeps valid ones', () => {
  const s = normalizeSettings({ fontSize: 99, lineHeight: 0.5, theme: 'dark', mode: 'paginated', conversion: 'cn' });
  assert.equal(s.fontSize, 28);
  assert.equal(s.lineHeight, 1.4);
  assert.equal(s.theme, 'dark');
  assert.equal(s.mode, 'paginated');
  assert.equal(s.conversion, 'cn');
});

// --- position -----------------------------------------------------------------------
test('savePosition/loadPosition roundtrip; corrupt data → null', () => {
  savePosition('w1', { chapterId: 'c1', revisionId: 'r1', paragraphIndex: 7, fraction: 0.5 });
  assert.deepEqual(loadPosition('w1'), { chapterId: 'c1', revisionId: 'r1', paragraphIndex: 7, fraction: 0.5 });
  mem['ebook:pos:w2'] = '{not json';
  assert.equal(loadPosition('w2'), null);
  mem['ebook:pos:w3'] = JSON.stringify({ chapterId: 'c3' }); // missing fields
  assert.equal(loadPosition('w3'), null);
});

test('remapPosition: same revision keeps paragraph; new revision clamps', () => {
  const pos = { chapterId: 'c1', revisionId: 'r1', paragraphIndex: 42 };
  assert.equal(remapPosition(pos, 'r1', 100).paragraphIndex, 42);
  assert.equal(remapPosition(pos, 'r2', 10).paragraphIndex, 9);   // clamped
  assert.equal(remapPosition(pos, 'r2', 0).paragraphIndex, 0);
});

test('loadSettings returns defaults with empty storage', () => {
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

// --- pagination ----------------------------------------------------------------------
test('clampPage and pageStep', () => {
  assert.equal(clampPage(5, 10), 5);
  assert.equal(clampPage(-1, 10), 0);
  assert.equal(clampPage(99, 10), 9);
  assert.equal(clampPage(0, 0), 0);
  assert.equal(pageStep(390, 48), 438);
});

test('debounce coalesces to trailing call', async () => {
  let calls = 0;
  const d = debounce(() => { calls++; }, 20);
  d(); d(); d();
  assert.equal(calls, 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1);
  d.cancel();
});

// --- conversion (§07): paragraph count invariant, real conversion works --------------
test('convertParagraphs: original copies; cn conversion keeps paragraph boundaries', async () => {
  const paras = ['記憶裡的聲音比畫面先回來', '時間像被誰按了慢放'];
  const original = await convertParagraphs(paras, 'original');
  assert.deepEqual(original, paras);
  assert.notEqual(original, paras); // copy, not same reference

  const cn = await convertParagraphs(paras, 'cn');
  assert.equal(cn.length, paras.length, 'paragraph count must not change');
  assert.equal(cn[0], '记忆里的声音比画面先回来');
});
