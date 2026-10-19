// robots.txt + sitemap routing and XML shape (SEO §03B), with a stubbed db so
// the routing and the escaping are testable without Postgres. The real queries
// are exercised in test/e2e-seo.test.ts against published content.
//
// One case here earns the file on its own: the obvious spelling of the paged
// routes, `/sitemap-works-:page{[0-9]+}.xml`, does NOT match in Hono — a param
// cannot carry a literal prefix inside its segment — and 404s every page while
// looking perfectly correct. These tests pin the whole-segment spelling.
// Run: pnpm --filter server test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sitemapRoutes } from './sitemap.ts';

const ORIGIN = 'https://books.example.test';

/** Returns the same canned rows for every query; each test asserts on shape,
 *  not on which statement produced it. */
function stubDb(rows: unknown[]): NodePgDatabase {
  return { execute: async () => ({ rows }) } as unknown as NodePgDatabase;
}

const routes = (rows: unknown[] = [], siteOrigin: string | null = ORIGIN) =>
  sitemapRoutes({ db: stubDb(rows), siteOrigin });

test('robots.txt disallows the private routes and points at the sitemap', async () => {
  const res = await routes().request('/robots.txt');
  assert.equal(res.status, 200);
  const body = await res.text();
  for (const line of ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /me/',
    'Disallow: /login', 'Disallow: /register', 'Disallow: /api/']) {
    assert.ok(body.includes(line), `missing "${line}"`);
  }
  assert.ok(body.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
  assert.match(res.headers.get('cache-control') ?? '', /max-age=3600/);
});

test('the index pages out by count and advertises no empty pages', async () => {
  const index = async (works: number, chapters: number) =>
    (await routes([{ works, chapters }]).request('/sitemap.xml')).text();

  // a urlset must hold at least one <url>, so nothing published means no page
  const empty = await index(0, 0);
  assert.ok(empty.includes('/sitemap-pages.xml'));
  assert.ok(!empty.includes('/sitemap-works-1.xml'));
  assert.ok(!empty.includes('/sitemap-chapters-1.xml'));

  const one = await index(1, 1);
  assert.ok(one.includes('/sitemap-works-1.xml'));
  assert.ok(one.includes('/sitemap-chapters-1.xml'));

  // 10,000 URLs per page: 10,001 chapters must advertise a second page
  const big = await index(1, 10_001);
  assert.ok(big.includes('/sitemap-chapters-2.xml'));
  assert.ok(!big.includes('/sitemap-works-2.xml'));
  assert.ok(!big.includes('/sitemap-chapters-3.xml'));
});

test('index and urlset are well-formed XML with the sitemaps.org namespace', async () => {
  const index = await routes([{ works: 1, chapters: 1 }]).request('/sitemap.xml');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /^application\/xml; charset=utf-8$/);
  const indexBody = await index.text();
  assert.ok(indexBody.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(indexBody.includes('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(indexBody.trimEnd().endsWith('</sitemapindex>'));

  const pages = await routes().request('/sitemap-pages.xml');
  const pagesBody = await pages.text();
  assert.ok(pagesBody.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(pagesBody.includes(`<loc>${ORIGIN}/</loc>`));
  assert.ok(pagesBody.includes(`<loc>${ORIGIN}/rankings</loc>`));
  // member and auth routes are personalized or private and stay out
  for (const path of ['/login', '/register', '/me/', '/admin']) {
    assert.ok(!pagesBody.includes(`<loc>${ORIGIN}${path}`), `${path} must not be advertised`);
  }
});

test('a work URL is absolute, percent-encoded and carries lastmod', async () => {
  const published = '2026-10-16T01:02:03.000Z';
  const res = await routes([{ public_id: 'a1b2c3d4', title: '劍來', published_at: published }])
    .request('/sitemap-works-1.xml');
  assert.equal(res.status, 200, 'the regex param must match inside the .xml segment');
  const body = await res.text();
  assert.ok(body.includes(`<loc>${ORIGIN}/works/${encodeURIComponent('劍來')}-a1b2c3d4</loc>`), body);
  assert.ok(body.includes(`<lastmod>${published}</lastmod>`));
});

test('a chapter URL nests the chapter slug under the work slug', async () => {
  const res = await routes([{
    work_public_id: 'a1b2c3d4', work_title: '劍來', chapter_public_id: '7f3e9b21',
    label_raw: '第一章', chapter_title: '落雨', published_at: '2026-10-16T00:00:00.000Z',
  }]).request('/sitemap-chapters-1.xml');
  assert.equal(res.status, 200);
  const body = await res.text();
  const expected = `/read/${encodeURIComponent('劍來')}-a1b2c3d4/${encodeURIComponent('第一章-落雨')}-7f3e9b21`;
  assert.ok(body.includes(`<loc>${ORIGIN}${expected}</loc>`), body);
});

// Titles are author-supplied. `&` cannot appear in a percent-encoded path, but
// escaping is unconditional rather than conditional on that reasoning holding.
test('titles that are XML metacharacters are escaped, not emitted raw', async () => {
  const res = await routes([{ public_id: 'a1b2c3d4', title: 'Tom & Jerry <b>', published_at: '2026-10-16T00:00:00.000Z' }])
    .request('/sitemap-works-1.xml');
  const body = await res.text();
  const loc = body.match(/<loc>(.*)<\/loc>/)![1];
  assert.ok(!/[<>]/.test(loc) && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(loc), `unescaped XML in ${loc}`);
  // the slug itself dropped the metacharacters as separators
  assert.ok(loc.endsWith('/works/tom-jerry-b-a1b2c3d4'), loc);
});

test('a page number that is not a number is not a route', async () => {
  for (const path of ['/sitemap-works-abc.xml', '/sitemap-works-.xml', '/sitemap-works.xml']) {
    assert.equal((await routes().request(path)).status, 404, `${path} should not route`);
  }
  // a page past the end is a valid, empty page rather than an error
  assert.equal((await routes([]).request('/sitemap-works-99.xml')).status, 200);
});

test('without SITE_ORIGIN the request origin is used, forwarded proto included', async () => {
  const res = await routes([], null).request('/sitemap-pages.xml', {
    headers: { host: 'books.example.test', 'x-forwarded-proto': 'https' },
  });
  const body = await res.text();
  assert.ok(body.includes('<loc>https://books.example.test/</loc>'), body);
});

test('a configured SITE_ORIGIN wins over a forged Host header', async () => {
  const res = await routes([]).request('/sitemap-pages.xml', { headers: { host: 'evil.example' } });
  const body = await res.text();
  assert.ok(body.includes(`<loc>${ORIGIN}/</loc>`));
  assert.ok(!body.includes('evil.example'), 'a forged Host must never reach a crawler');
});
