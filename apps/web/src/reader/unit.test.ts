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
const { normalizeSettings, remapPosition, loadPosition, savePosition, loadSettings, saveSettings, resolveTheme, parsePositionHash, DEFAULT_SETTINGS } = await import('./reader-state.ts');
const { clampPage, pageStep, debounce, tapZone, TAP_BAND } = await import('./pagination.ts');
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

// --- theme ------------------------------------------------------------------------
test("theme defaults to following the system", () => {
  assert.equal(DEFAULT_SETTINGS.theme, 'system');
  assert.equal(normalizeSettings({}).theme, 'system');
  assert.equal(normalizeSettings({ theme: 'nonsense' }).theme, 'system');
});

test("v1 settings: a stored 'light' was the old default, so it migrates to system", () => {
  assert.equal(normalizeSettings({ theme: 'light', fontSize: 20 }).theme, 'system');
  // the rest of a v1 payload is untouched by the migration
  assert.equal(normalizeSettings({ theme: 'light', fontSize: 20 }).fontSize, 20);
});

test('v1 settings: a deliberate 護眼/深色 choice is never overwritten', () => {
  assert.equal(normalizeSettings({ theme: 'sepia' }).theme, 'sepia');
  assert.equal(normalizeSettings({ theme: 'dark' }).theme, 'dark');
});

test("v2 settings: an explicit 'light' is a real choice and survives", () => {
  assert.equal(normalizeSettings({ theme: 'light', v: 2 }).theme, 'light');
  assert.equal(normalizeSettings({ theme: 'system', v: 2 }).theme, 'system');
});

test('saved settings carry the version, so the migration runs exactly once', () => {
  saveSettings({ ...DEFAULT_SETTINGS, theme: 'light' });
  assert.equal(loadSettings().theme, 'light');
  // storage is shared across tests in this file; a later case asserts defaults
  localStorage.removeItem('ebook:reader-settings');
});

test('resolveTheme: only system consults the OS', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('sepia', true), 'sepia');
  assert.equal(resolveTheme('dark', false), 'dark');
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

// a bookmark opens `/read/:work/:chapter#p=<index>&rev=<revision>`
test('parsePositionHash: reads a bookmark anchor, rejects anything partial', () => {
  assert.deepEqual(parsePositionHash('#p=12&rev=r1'), { paragraphIndex: 12, revisionId: 'r1' });
  assert.deepEqual(parsePositionHash('p=0&rev=r1'), { paragraphIndex: 0, revisionId: 'r1' });
  assert.equal(parsePositionHash(''), null);
  assert.equal(parsePositionHash('#p=12'), null);          // no revision to compare
  assert.equal(parsePositionHash('#rev=r1'), null);        // no paragraph
  assert.equal(parsePositionHash('#p=-1&rev=r1'), null);
  assert.equal(parsePositionHash('#p=1.5&rev=r1'), null);
  assert.equal(parsePositionHash('#p=x&rev=r1'), null);
});

// --- pagination ----------------------------------------------------------------------
test('clampPage and pageStep', () => {
  assert.equal(clampPage(5, 10), 5);
  assert.equal(clampPage(-1, 10), 0);
  assert.equal(clampPage(99, 10), 9);
  assert.equal(clampPage(0, 0), 0);
  assert.equal(pageStep(390, 48), 438);
});

// §9.2: the bottom band turns forward, the top band back, the middle half is
// the chrome — and an unmeasured box never turns a page by accident
test('tapZone: bottom band → next, top band → prev, middle → chrome', () => {
  const h = 844;
  assert.equal(tapZone(10, h), 'prev');
  assert.equal(tapZone(h * TAP_BAND - 1, h), 'prev');
  assert.equal(tapZone(h * TAP_BAND, h), 'chrome');      // the band is exclusive
  assert.equal(tapZone(h / 2, h), 'chrome');
  assert.equal(tapZone(h * (1 - TAP_BAND), h), 'chrome');
  assert.equal(tapZone(h * (1 - TAP_BAND) + 1, h), 'next');
  assert.equal(tapZone(h - 1, h), 'next');
  // degenerate geometry: a tap must not move the saved position
  assert.equal(tapZone(0, 0), 'chrome');
  assert.equal(tapZone(50, Number.NaN), 'chrome');
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
