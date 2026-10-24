// PWA asset integrity (RV-018). Two things a reviewer cannot see by reading a
// diff: whether the manifest still points at files that exist, and whether the
// PNGs were regenerated after someone edited the SVG they come from.
//
// The PNGs are committed rather than built, because the repo has no
// rasterizer and adding one for four files is a worse trade than this test.
// The cost of committing them is exactly this drift risk, so the hashes below
// are the thing that makes the trade honest.
//
// Regenerating (headless Chrome is enough, no new dependency):
//   see docs/tickets/review-2026-10-24/RV-018-pwa.md
//
// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
const read = (name: string) => readFileSync(`${PUBLIC}${name}`);

/** sha256 prefix of each SVG at the time its PNGs were last generated. */
const SOURCE_HASHES: Record<string, string> = {
  'icon.svg': 'fcd33e9bbde2d154',
  'icon-maskable.svg': '043e9cc4ebb47918',
  'favicon.svg': 'f50d30279eadd37e',
};

/** PNG dimensions straight out of the IHDR chunk — no image library needed. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', 'not a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('the committed PNG icons match the SVGs they were generated from', () => {
  for (const [name, expected] of Object.entries(SOURCE_HASHES)) {
    const actual = createHash('sha256').update(read(name)).digest('hex').slice(0, 16);
    assert.equal(actual, expected,
      `${name} changed but the PNGs were not regenerated. Re-render icon-192/512, `
      + 'icon-maskable-512 and apple-touch-icon, then update SOURCE_HASHES.');
  }
});

test('every icon the manifest promises exists at the size it claims', () => {
  const manifest = JSON.parse(read('manifest.webmanifest').toString('utf8')) as {
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
    start_url: string; scope: string; display: string;
  };
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\//, '');
    assert.ok(existsSync(`${PUBLIC}${file}`), `manifest points at a missing ${icon.src}`);
    if (icon.type !== 'image/png') continue;
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(read(file)), { width: w, height: h },
      `${icon.src} is not ${icon.sizes}`);
  }
  // A maskable icon that is actually the `any` art gets its edges cropped off
  // by the platform mask, so the two must not be the same file.
  const purposes = manifest.icons.map((icon) => icon.purpose);
  assert.ok(purposes.includes('maskable'), 'no maskable icon: platforms will crop the mark');
  assert.ok(purposes.includes('any'), 'no `any` icon');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  // start_url carries a source tag; App.tsx strips the query before building a
  // canonical path, so this cannot become a second indexable copy of the
  // catalogue (RV-001).
  assert.match(manifest.start_url, /^\/(\?|$)/);
});

test('apple-touch-icon exists at 180 and is full-bleed, not the rounded art', () => {
  const bytes = read('apple-touch-icon.png');
  assert.deepEqual(pngSize(bytes), { width: 180, height: 180 });
  // iOS applies its own squircle mask. A PNG with its own transparent rounded
  // corners gets masked twice and shows a pale ring; the full-bleed source has
  // no alpha channel at all (colour type 2 rather than 6).
  assert.equal(bytes.readUInt8(25), 2, 'apple-touch-icon must be opaque and full-bleed');
});

test('the service worker never caches an API response', () => {
  const source = read('sw.js').toString('utf8');
  assert.match(source, /isApi/, 'the API guard was removed');
  assert.match(source, /if \(isApi\(url\)\) return;/,
    'API requests must return before any caching branch');
  // and it must not be registered over the dev server
  const registration = readFileSync(fileURLToPath(new URL('../pwa.ts', import.meta.url)), 'utf8');
  assert.match(registration, /import\.meta\.env\.PROD/);
});
