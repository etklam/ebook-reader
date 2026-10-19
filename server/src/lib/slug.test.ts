// Canonical URL construction, server side (SEO §03B). The sitemap advertises
// URLs that the client must build identically, so this file asserts both the
// behaviour and — because the module is deliberately duplicated in
// apps/web/src/lib/slug.ts — that the two copies have not drifted apart.
// Run: pnpm --filter server test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slugify, slugWithId, workPath, readPath, parseRef } from './slug.ts';

const UUID = '3f2a1b4c-8d9e-4f10-b2c3-5a6b7c8d9e0f';

test('slugify keeps CJK and words, turns everything else into separators', () => {
  assert.equal(slugify('劍來'), '劍來');
  assert.equal(slugify('第一章 落雨'), '第一章-落雨');
  assert.equal(slugify('Sword of Destiny'), 'sword-of-destiny');
  assert.equal(slugify('《劍來》：第一卷'), '劍來-第一卷');
  assert.equal(slugify('！？…—'), '');
  assert.equal(slugify('字'.repeat(80)).length, 40);
});

test('paths put the key last and fall back to the bare id', () => {
  assert.equal(workPath({ title: '劍來', publicId: 'a1b2c3d4' }), '/works/劍來-a1b2c3d4');
  assert.equal(workPath({ title: '？？', publicId: 'a1b2c3d4' }), '/works/a1b2c3d4');
  assert.equal(slugWithId('Sword of Destiny', 'a1b2c3d4'), 'sword-of-destiny-a1b2c3d4');
  assert.equal(
    readPath({ title: '劍來', publicId: 'a1b2c3d4' },
      { labelRaw: '第一章', title: '落雨', publicId: '7f3e9b21' }),
    '/read/劍來-a1b2c3d4/第一章-落雨-7f3e9b21',
  );
  assert.equal(readPath({ title: '劍來', publicId: 'a1b2c3d4' }), '/read/劍來-a1b2c3d4');
});

test('parseRef reads both URL forms and rejects the rest', () => {
  assert.deepEqual(parseRef('劍來-a1b2c3d4'), { publicId: 'a1b2c3d4' });
  assert.deepEqual(parseRef(encodeURIComponent('劍來') + '-a1b2c3d4'), { publicId: 'a1b2c3d4' });
  assert.deepEqual(parseRef(UUID), { workId: UUID });
  assert.equal(parseRef('劍來'), null);
  assert.equal(parseRef('劍來-ZZZZZZZZ'), null);
  assert.equal(parseRef(''), null);
});

// Drift guard. The slug rules are duplicated rather than shared (no common
// package between `server` and `apps/web`), and a silent divergence would make
// every sitemap URL redirect to a slightly different path — two URLs for one
// page, which is precisely what canonicalization is supposed to prevent.
// Scoped to the slug rules themselves — SLUG_MAX, the character class,
// slugify and slugWithId. The ref parsers are intentionally not identical
// (they return differently named keys for their own callers) and are covered
// behaviourally above and in apps/web/src/lib/slug.test.ts.
test('the web copy of the slug rules is byte-identical', () => {
  const extract = (path: string) => {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    const start = src.indexOf('const SLUG_MAX');
    const close = src.indexOf('\n}\n', src.indexOf('export function slugWithId'));
    assert.ok(start > 0 && close > start, `shared block not found in ${path}`);
    return src.slice(start, close);
  };
  assert.equal(
    extract('./slug.ts'),
    extract('../../../apps/web/src/lib/slug.ts'),
    'server/src/lib/slug.ts and apps/web/src/lib/slug.ts have drifted',
  );
});
