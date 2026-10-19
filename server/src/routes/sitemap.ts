// Crawlable surface: robots.txt + a paginated sitemap index (SEO §03B).
//
// Why these live on the API and not next to the static bundle: the URL set is
// the catalogue, which changes on every publish. A file baked at build time
// would be stale the moment an admin publishes a chapter, and a crawler that
// learns to distrust the sitemap stops reading it.
//
// Only PUBLIC works appear. `unlisted` means "reachable by direct URL, never
// listed" (reader.ts §8) — putting one in a sitemap is exactly the listing it
// was promised to be exempt from. Drafts and removed works have no public URL.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readPath, workPath } from '../lib/slug.ts';

export interface SitemapDeps {
  db: NodePgDatabase;
  /** configured public origin; null falls back to the request's own */
  siteOrigin: string | null;
}

/** URLs per sitemap page. The protocol's ceiling is 50,000 / 50 MB; CJK titles
 *  percent-encode to ~9 bytes a character, so a lower cap keeps every page
 *  comfortably inside the byte limit too. */
const PAGE_SIZE = 10_000;

// Crawlers re-fetch a sitemap far more often than it changes. An hour is long
// enough to blunt a crawl burst and short enough that a new chapter is found
// the same day.
const CACHE = 'public, max-age=3600';

function origin(c: Context, configured: string | null): string {
  if (configured) return configured;
  // dev fallback: trusts the Host header, which is why production sets
  // SITE_ORIGIN (see config.ts)
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  return `${proto ?? url.protocol.replace(':', '')}://${c.req.header('host') ?? url.host}`;
}

// XML text escaping. Titles are author-supplied, and `&` in a percent-encoded
// path is impossible but `&` in a bare query is not — escape unconditionally
// rather than reasoning about which fields are safe.
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** A path built from a title → a valid absolute URL. encodeURI leaves the
 *  structural characters alone and percent-encodes the CJK, which is what
 *  browsers display decoded and crawlers accept. */
function absolute(base: string, path: string): string {
  return xmlEscape(base + encodeURI(path));
}

/** `sitemap-works-12.xml` → 12. The route regex has already guaranteed the
 *  digits are there, so this never has to defend against a missing match. */
function pageNumber(file: string): number {
  return Math.max(1, Number(/([0-9]+)\.xml$/.exec(file)![1]));
}

function urlset(entries: Array<{ loc: string; lastmod?: string | null }>): string {
  const body = entries.map(({ loc, lastmod }) =>
    `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>\n`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}</urlset>\n`;
}

export function sitemapRoutes(deps: SitemapDeps): Hono {
  const { db, siteOrigin } = deps;
  const app = new Hono();

  app.get('/robots.txt', (c) => {
    const base = origin(c, siteOrigin);
    // Admin, member and auth routes are disallowed because they are private or
    // personalized, never because they are secret — robots.txt is a public file
    // and hides nothing. Access control lives in the API.
    const body = [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /me/',
      'Disallow: /login',
      'Disallow: /register',
      'Disallow: /api/',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n');
    c.header('Cache-Control', CACHE);
    return c.text(body);
  });

  // index: the catalogue's own pages plus one page of work URLs and one of
  // chapter URLs per PAGE_SIZE rows
  app.get('/sitemap.xml', async (c) => {
    const base = origin(c, siteOrigin);
    const [counts] = (await db.execute(sql`
      select
        (select count(*)::int from app.works
          where visibility = 'public' and active_release_id is not null) as works,
        (select count(*)::int from app.release_items ri
          join app.work_releases r on r.id = ri.release_id
          join app.works w on w.id = r.work_id and w.active_release_id = ri.release_id
          where w.visibility = 'public') as chapters
    `)).rows as unknown as Array<{ works: number; chapters: number }>;
    // No rows means no page: the schema requires a urlset to hold at least one
    // <url>, so advertising an empty page would hand a crawler invalid XML.
    const pages = (kind: string, total: number) => Array.from(
      { length: Math.ceil(total / PAGE_SIZE) },
      (_, i) => `  <sitemap><loc>${xmlEscape(`${base}/sitemap-${kind}-${i + 1}.xml`)}</loc></sitemap>`,
    );
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + `  <sitemap><loc>${xmlEscape(`${base}/sitemap-pages.xml`)}</loc></sitemap>\n`
      + [...pages('works', counts.works), ...pages('chapters', counts.chapters)]
        .map((line) => `${line}\n`).join('')
      + `</sitemapindex>\n`;
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', CACHE);
    return c.body(body);
  });

  // the handful of static routes worth indexing. /login, /register and
  // everything under /me are personalized or private and stay out.
  app.get('/sitemap-pages.xml', (c) => {
    const base = origin(c, siteOrigin);
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', CACHE);
    return c.body(urlset([{ loc: absolute(base, '/') }, { loc: absolute(base, '/rankings') }]));
  });

  // Offset paging is deliberate here. The catalogue forbids it (CAT-03: a
  // publish mid-scroll would shift a reader's window and silently skip a
  // book), but a crawler fetches these pages once and re-fetches the whole
  // index later — a row that moves between pages is found on the next crawl.
  // The page number is matched as part of a WHOLE-segment regex rather than as
  // `/sitemap-works-:page{[0-9]+}.xml`: Hono does not match a param that has a
  // literal prefix inside its segment, and that spelling silently 404s every
  // page (covered by sitemap.test.ts).
  app.get(`/:file{sitemap-works-[0-9]+\\.xml}`, async (c) => {
    const base = origin(c, siteOrigin);
    const page = pageNumber(c.req.param('file'));
    const rows = (await db.execute(sql`
      select w.public_id, w.title, r.published_at
      from app.works w
      join app.work_releases r on r.id = w.active_release_id and r.work_id = w.id
      where w.visibility = 'public'
      order by w.created_at asc, w.id asc
      limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}
    `)).rows as unknown as Array<{ public_id: string; title: string; published_at: Date }>;
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', CACHE);
    return c.body(urlset(rows.map((w) => ({
      loc: absolute(base, workPath({ title: w.title, publicId: w.public_id })),
      lastmod: new Date(w.published_at).toISOString(),
    }))));
  });

  // Chapter URLs come from release_items — the snapshot the public is actually
  // reading. Taking them from app.chapters would advertise editorial head
  // chapters that have not been published yet.
  app.get(`/:file{sitemap-chapters-[0-9]+\\.xml}`, async (c) => {
    const base = origin(c, siteOrigin);
    const page = pageNumber(c.req.param('file'));
    const rows = (await db.execute(sql`
      select w.public_id as work_public_id, w.title as work_title,
             c.public_id as chapter_public_id, ri.label_raw, ri.title as chapter_title,
             r.published_at
      from app.release_items ri
      join app.work_releases r on r.id = ri.release_id
      join app.works w on w.id = r.work_id and w.active_release_id = ri.release_id
      join app.chapters c on c.id = ri.chapter_id
      where w.visibility = 'public'
      order by w.created_at asc, w.id asc, ri.editorial_position asc
      limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}
    `)).rows as unknown as Array<{
      work_public_id: string; work_title: string; chapter_public_id: string;
      label_raw: string; chapter_title: string; published_at: Date;
    }>;
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', CACHE);
    return c.body(urlset(rows.map((r) => ({
      loc: absolute(base, readPath(
        { title: r.work_title, publicId: r.work_public_id },
        { labelRaw: r.label_raw, title: r.chapter_title, publicId: r.chapter_public_id },
      )),
      lastmod: new Date(r.published_at).toISOString(),
    }))));
  });

  return app;
}
