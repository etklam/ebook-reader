// Canonical URL construction (SEO §03B). The server mirrors this module, so
// these cases are duplicated in server/src/lib/slug.test.ts — if the two ever
// disagree the sitemap advertises URLs the app immediately rewrites.
// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { slugify, slugWithId, workPath, readPath, parseRef, isUuid, samePath } = await import('./slug.ts');

const UUID = '3f2a1b4c-8d9e-4f10-b2c3-5a6b7c8d9e0f';

test('slugify keeps CJK and words, turns everything else into separators', () => {
  assert.equal(slugify('劍來'), '劍來');
  assert.equal(slugify('第一章 落雨'), '第一章-落雨');
  assert.equal(slugify('Sword of Destiny'), 'sword-of-destiny');
  assert.equal(slugify('《劍來》：第一卷'), '劍來-第一卷');
  assert.equal(slugify('  trailing  '), 'trailing');
  assert.equal(slugify('こころ ノート'), 'こころ-ノート');
});

test('slugify never yields a leading, trailing or doubled separator', () => {
  for (const input of ['---', '！！！劍來？？？', '  ·  劍  ·  ', 'a---b']) {
    const slug = slugify(input);
    assert.ok(!slug.startsWith('-') && !slug.endsWith('-'), `edge separator in ${JSON.stringify(slug)}`);
    assert.ok(!slug.includes('--'), `doubled separator in ${JSON.stringify(slug)}`);
  }
});

test('slugify returns empty for input with nothing to slug', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('！？…—'), '');
  // and the path then falls back to the bare id rather than emitting `/works/-id`
  assert.equal(slugWithId('！？', 'a1b2c3d4'), 'a1b2c3d4');
  assert.equal(workPath({ id: UUID, publicId: 'a1b2c3d4', title: '？？' }), '/works/a1b2c3d4');
});

test('slugify caps length on a separator boundary', () => {
  const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
  assert.ok(long.length <= 40, `too long: ${long.length}`);
  assert.equal(long, 'a'.repeat(30));           // cut back to the separator
  // a single unbroken run has no separator to cut back to; it is simply capped
  assert.equal(slugify('字'.repeat(80)).length, 40);
});

test('paths put the key last so a dashed slug stays parseable', () => {
  const work = { id: UUID, publicId: 'a1b2c3d4', title: 'Sword of Destiny' };
  assert.equal(workPath(work), '/works/sword-of-destiny-a1b2c3d4');
  assert.deepEqual(parseRef('sword-of-destiny-a1b2c3d4'), { publicId: 'a1b2c3d4' });
});

test('readPath builds the chapter segment from label and title together', () => {
  const work = { id: UUID, publicId: 'a1b2c3d4', title: '劍來' };
  assert.equal(
    readPath(work, { id: UUID, publicId: '7f3e9b21', labelRaw: '第一章', title: '落雨' }),
    '/read/劍來-a1b2c3d4/第一章-落雨-7f3e9b21',
  );
  assert.equal(readPath(work), '/read/劍來-a1b2c3d4');
  // a chapter known only by uuid (a resumed position) still produces a path
  // the server resolves; the reader canonicalizes it once the label arrives
  assert.equal(readPath(work, { id: UUID }), `/read/劍來-a1b2c3d4/${UUID}`);
});

test('a work without a publicId falls back to its uuid', () => {
  assert.equal(workPath({ id: UUID }), `/works/${UUID}`);
  assert.equal(workPath({ id: UUID, title: '劍來' }), `/works/${UUID}`);
});

test('parseRef reads both URL forms and rejects the rest', () => {
  assert.deepEqual(parseRef('a1b2c3d4'), { publicId: 'a1b2c3d4' });
  assert.deepEqual(parseRef('劍來-a1b2c3d4'), { publicId: 'a1b2c3d4' });
  // percent-encoded is what actually arrives over the wire
  assert.deepEqual(parseRef(encodeURIComponent('劍來') + '-a1b2c3d4'), { publicId: 'a1b2c3d4' });
  assert.deepEqual(parseRef(UUID), { uuid: UUID });
  assert.deepEqual(parseRef(UUID.toUpperCase()), { uuid: UUID });
  assert.equal(parseRef('劍來'), null);              // no key at all
  assert.equal(parseRef('a1b2c3d'), null);           // 7 chars
  assert.equal(parseRef('a1b2c3d4e'), null);         // 9 chars
  assert.equal(parseRef('劍來-ZZZZZZZZ'), null);     // not hex
  assert.equal(parseRef(''), null);
  // a malformed escape must not throw on a route
  assert.equal(parseRef('%E5-a1b2c3d4') && 'publicId' in parseRef('%E5-a1b2c3d4')!, true);
});

// the address bar holds the encoded form; canonical paths are built raw, so a
// naive comparison would rewrite the URL on every single chapter load
test('samePath compares an encoded location against a raw canonical path', () => {
  const canonical = '/read/劍來-a1b2c3d4/第一章-7f3e9b21';
  assert.equal(samePath(encodeURI(canonical), canonical), true);
  assert.equal(samePath(canonical, canonical), true);
  assert.equal(samePath('/read/劍來-a1b2c3d4/第二章-7f3e9b22', canonical), false);
  // a malformed escape compares as itself rather than throwing
  assert.equal(samePath('/read/%E5', '/read/%E5'), true);
});

test('isUuid distinguishes a legacy link from a slug segment', () => {
  assert.equal(isUuid(UUID), true);
  assert.equal(isUuid('劍來-a1b2c3d4'), false);
});

// round trip: whatever a path builder emits, the router must be able to read
test('every built path parses back to the same key', () => {
  const work = { id: UUID, publicId: 'a1b2c3d4', title: '劍來：第一卷' };
  for (const chapter of [
    { id: UUID, publicId: '7f3e9b21', labelRaw: '第 12.5 章', title: '' },
    { id: UUID, publicId: '7f3e9b21', labelRaw: '', title: 'Prologue — the rain' },
    { id: UUID, publicId: '7f3e9b21', labelRaw: '！？', title: '' },
  ]) {
    const path = readPath(work, chapter);
    const [, , workSeg, chapterSeg] = path.split('/');
    assert.deepEqual(parseRef(workSeg), { publicId: 'a1b2c3d4' });
    assert.deepEqual(parseRef(chapterSeg), { publicId: '7f3e9b21' });
  }
});
