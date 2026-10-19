// L2 E2E acceptance (SEO §03B): slug URL resolution, public ids on every
// public DTO, robots.txt, and the sitemap index. Built on a genuinely imported
// and published work, because the sitemap reads release_items — the snapshot
// the public is actually served — and a fixture written straight into the
// tables would not prove that.
//
// Run: pnpm --filter server test:e2e   (needs `pnpm db:up` + `pnpm db:migrate`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-seo-'));
const { app } = await import('../src/index.ts');
const { runOnce } = await import('../src/import/queue.ts');
const { localStorage } = await import('../src/storage.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const { makeDb } = await import('../src/db/client.ts');
const { readPath, workPath } = await import('../src/lib/slug.ts');

const storage = localStorage(process.env.STORAGE_ROOT);
const FIXTURES = fileURLToPath(new URL('../../m0/fixtures/txt', import.meta.url));
const SUFFIX = Math.random().toString(36).slice(2, 8);

const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const workerDb = makeDb(workerPool);

async function q(sql: string, params: unknown[] = []) {
  const res = await workerPool.query(sql, params);
  return res.rows;
}

async function login(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, 'login should succeed');
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

async function processUntil(importId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const processed = await runOnce(workerDb, storage, { owner: `e2e-seo-${SUFFIX}`, leaseMs: 300_000, heartbeatMs: 100_000, maxAttempts: 3, storageConcurrency: 6 });
    if (processed === importId) return;
    const rows = await q(`select status from app.import_jobs where id=$1`, [importId]);
    if (rows[0] && !['queued', 'processing'].includes(rows[0].status)) return;
    if (!processed) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${importId} was never claimed`);
}

async function importAndCommit(name: string, bytes: Buffer, cookie: string, title: string): Promise<string> {
  const form = new FormData();
  form.append('file', new File([bytes], name));
  const up = await app.request('/api/admin/imports', { method: 'POST', headers: { cookie }, body: form });
  assert.equal(up.status, 201);
  const { importId } = await up.json() as { importId: string };
  await processUntil(importId);
  const commit = await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title, workType: 'serial' }),
  });
  assert.equal(commit.status, 200);
  return ((await commit.json()) as { workId: string }).workId;
}

const TITLE = () => `SEO測試：劍來-${SUFFIX}`;
const HIDDEN_TITLE = () => `SEO隱藏-${SUFFIX}`;

let admin = '';
let work = '';            // public, published
let hidden = '';          // unlisted, published — readable by URL, never listed
let categoryId = '';
let workPublicId = '';
let firstChapter = { id: '', publicId: '', labelRaw: '', title: '' };

before(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
  await pool.query(
    `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,'admin')`,
    [`e2e-seo-admin-${SUFFIX}`, `e2e-seo-admin-${SUFFIX}@example.test`, await hashPassword('pw-12345678')]);
  await pool.end();
  admin = await login(`e2e-seo-admin-${SUFFIX}@example.test`, 'pw-12345678');

  const fixture = readFileSync(join(FIXTURES, 'weird-labels.txt'));
  work = await importAndCommit('weird-labels.txt', fixture, admin, TITLE());
  hidden = await importAndCommit('weird-labels.txt', fixture, admin, HIDDEN_TITLE());
  [categoryId] = (await q(`insert into app.categories (display_name) values ($1) returning id`,
    [`SEO測試分類-${SUFFIX}`])).map((r: { id: string }) => r.id);
  for (const id of [work, hidden]) {
    await q(`insert into app.work_categories (work_id, category_id) values ($1,$2)`, [id, categoryId]);
    await q(`update app.works set serial_status='ongoing' where id=$1`, [id]);
    const res = await app.request(`/api/admin/works/${id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': `seo-${id}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200, `publish ${id}`);
  }
  await q(`update app.works set visibility='public' where id=$1`, [work]);
  await q(`update app.works set visibility='unlisted' where id=$1`, [hidden]);

  [{ public_id: workPublicId }] = await q(`select public_id from app.works where id=$1`, [work]) as Array<{ public_id: string }>;
  const [row] = await q(
    `select c.id, c.public_id, ri.label_raw, ri.title
       from app.chapters c join app.release_items ri on ri.chapter_id=c.id
       join app.works w on w.active_release_id=ri.release_id
       where w.id=$1 order by ri.editorial_position limit 1`, [work],
  ) as Array<{ id: string; public_id: string; label_raw: string; title: string }>;
  firstChapter = { id: row.id, publicId: row.public_id, labelRaw: row.label_raw, title: row.title };
});

after(async () => {
  for (const w of await q(`select id from app.works where title like '%' || $1 || '%'`, [SUFFIX])) {
    await q(`update app.source_files set work_id=null where work_id=$1`, [w.id]);
    await q(`update app.import_jobs set work_id=null where work_id=$1`, [w.id]);
    await q(`update app.chapters set head_revision_id=null where work_id=$1`, [w.id]);
    await q(`delete from app.release_items where release_id in (select id from app.work_releases where work_id=$1)`, [w.id]);
    await q(`delete from app.publication_events where work_id=$1`, [w.id]);
    await q(`update app.works set active_release_id=null where id=$1`, [w.id]);
    await q(`delete from app.work_releases where work_id=$1`, [w.id]);
    await q(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [w.id]);
    await q(`delete from app.chapters where work_id=$1`, [w.id]);
    await q(`delete from app.work_categories where work_id=$1`, [w.id]);
    await q(`delete from app.works where id=$1`, [w.id]);
  }
  await q(`delete from app.categories where id=$1`, [categoryId]).catch(() => undefined);
  const jobs = await q(`select id from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%'||$1||'%')`, [`seo-admin-${SUFFIX}`]);
  for (const j of jobs) {
    await q(`delete from app.import_items where import_job_id=$1`, [j.id]);
    await q(`delete from app.import_jobs where id=$1`, [j.id]);
  }
  await q(`delete from app.source_files s where not exists (select 1 from app.import_jobs j where j.source_file_id = s.id) and s.created_at > now() - interval '1 hour'`);
  await q(`delete from app.sessions where user_id in (select id from app.users where email like '%'||$1||'%')`, [`seo-admin-${SUFFIX}`]);
  await q(`delete from app.users where email like '%'||$1||'%'`, [`seo-admin-${SUFFIX}`]);
  workerPool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

test('SEO-01: public_id is generated from the row id and is unique', async () => {
  const rows = await q(
    `select id, public_id from app.works where id in ($1,$2)`, [work, hidden],
  ) as Array<{ id: string; public_id: string }>;
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.match(r.public_id, /^[0-9a-f]{8}$/);
    // derived from the uuid, so it is stable for the lifetime of the row
    assert.equal(r.public_id, r.id.replace(/-/g, '').slice(0, 8));
  }
  assert.notEqual(rows[0].public_id, rows[1].public_id);
  // generated always: it cannot be written, so no insert path can get it wrong
  await assert.rejects(
    () => q(`update app.works set public_id='deadbeef' where id=$1`, [work]),
    { code: '428C9' }, // generated_always; independent of PostgreSQL error wording
  );
});

test('SEO-02: a work resolves by slug path, by bare public id, and by uuid', async () => {
  const bodies = [];
  for (const ref of [
    encodeURIComponent(`seo測試-劍來-${SUFFIX}`) + `-${workPublicId}`,  // slug + key
    workPublicId,                                                      // key alone
    work,                                                              // legacy uuid link
    `totally-wrong-slug-${workPublicId}`,                              // stale slug
  ]) {
    const res = await app.request(`/api/reader/works/${ref}`);
    assert.equal(res.status, 200, `ref ${ref} should resolve`);
    bodies.push(await res.json() as { id: string; publicId: string; title: string });
  }
  // the slug is decorative: every form answers with the same work
  for (const b of bodies) {
    assert.equal(b.id, work);
    assert.equal(b.publicId, workPublicId);
    assert.equal(b.title, TITLE());
  }
  // and the detail endpoint agrees
  const detail = await app.request(`/api/works/${workPublicId}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { publicId: string }).publicId, workPublicId);
});

test('SEO-03: a segment with no usable key is a 404, not a scan', async () => {
  for (const ref of ['劍來', 'a1b2c3d', 'zzzzzzzz-', '%%%']) {
    const res = await app.request(`/api/reader/works/${encodeURIComponent(ref)}`);
    assert.equal(res.status, 404, `ref ${ref} must not resolve`);
    assert.equal((await res.json() as { error: string }).error, 'work_not_found');
  }
  // a well-formed key that belongs to nothing is also a plain 404
  const res = await app.request('/api/reader/works/ffffffff');
  assert.equal(res.status, 404);
});

test('SEO-04: a chapter public id resolves only within its own work', async () => {
  const ok = await app.request(
    `/api/reader/chapters/${firstChapter.publicId}?work=${workPublicId}`);
  assert.equal(ok.status, 200);
  const body = await ok.json() as { chapterId: string; publicId: string };
  assert.equal(body.chapterId, firstChapter.id);
  assert.equal(body.publicId, firstChapter.publicId);

  // chapter public ids are unique per work, so the key alone is not an address
  const bare = await app.request(`/api/reader/chapters/${firstChapter.publicId}`);
  assert.equal(bare.status, 404);

  // ...and it must not resolve under a different work
  const [other] = await q(`select public_id from app.works where id=$1`, [hidden]) as Array<{ public_id: string }>;
  const crossed = await app.request(
    `/api/reader/chapters/${firstChapter.publicId}?work=${other.public_id}`);
  assert.equal(crossed.status, 404);

  // the uuid form still works with no help at all (bookmarks, page turns)
  const byUuid = await app.request(`/api/reader/chapters/${firstChapter.id}`);
  assert.equal(byUuid.status, 200);
});

test('SEO-05: public ids reach every DTO the client builds links from', async () => {
  const toc = await app.request(`/api/reader/works/${workPublicId}/chapters?limit=5&offset=0`);
  assert.equal(toc.status, 200);
  const entries = (await toc.json() as { chapters: Array<{ id: string; publicId: string }> }).chapters;
  assert.ok(entries.length > 0);
  for (const e of entries) assert.match(e.publicId, /^[0-9a-f]{8}$/);
  assert.equal(entries[0].publicId, firstChapter.publicId);

  const catalog = await app.request(`/api/works?q=${encodeURIComponent(SUFFIX)}`);
  assert.equal(catalog.status, 200);
  const listed = (await catalog.json() as { works: Array<{ id: string; publicId: string }> }).works;
  const mine = listed.find((w) => w.id === work);
  assert.ok(mine, 'the published public work is listed');
  assert.equal(mine.publicId, workPublicId);

  const related = await app.request(`/api/works/${workPublicId}/related`);
  assert.equal(related.status, 200);   // resolves by public id, however empty
});

test('SEO-06: robots.txt keeps private routes out and advertises the sitemap', async () => {
  const res = await app.request('/robots.txt');
  assert.equal(res.status, 200);
  const body = await res.text();
  for (const line of ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /me/', 'Disallow: /api/']) {
    assert.ok(body.includes(line), `robots.txt should contain "${line}"`);
  }
  assert.match(body, /^Sitemap: https?:\/\/[^\s]+\/sitemap\.xml$/m);
});

test('SEO-07: the sitemap index lists its pages and is cacheable', async () => {
  const res = await app.request('/sitemap.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/xml/);
  assert.match(res.headers.get('cache-control') ?? '', /max-age=\d+/);
  const body = await res.text();
  assert.ok(body.startsWith('<?xml'), 'declares an XML prolog');
  assert.match(body, /<sitemapindex/);
  for (const page of ['/sitemap-pages.xml', '/sitemap-works-1.xml', '/sitemap-chapters-1.xml']) {
    assert.ok(body.includes(page), `index should link ${page}`);
  }
});

test('SEO-08: work and chapter sitemaps carry canonical slug URLs, and never an unlisted work', async () => {
  const works = await (await app.request('/sitemap-works-1.xml')).text();
  const expected = workPath({ title: TITLE(), publicId: workPublicId });
  assert.ok(works.includes(encodeURI(expected)), `works sitemap should contain ${expected}`);
  assert.match(works, /<lastmod>\d{4}-\d{2}-\d{2}T/);

  const chapters = await (await app.request('/sitemap-chapters-1.xml')).text();
  const chapterUrl = readPath(
    { title: TITLE(), publicId: workPublicId },
    { labelRaw: firstChapter.labelRaw, title: firstChapter.title, publicId: firstChapter.publicId },
  );
  assert.ok(chapters.includes(encodeURI(chapterUrl)), `chapters sitemap should contain ${chapterUrl}`);

  // `unlisted` is readable by direct URL but must never be listed anywhere —
  // a sitemap is the most emphatic listing there is
  const hiddenPublicId = (await q(`select public_id from app.works where id=$1`, [hidden]) as Array<{ public_id: string }>)[0].public_id;
  assert.ok(!works.includes(hiddenPublicId), 'unlisted work must not appear in the sitemap');
  assert.ok(!chapters.includes(hiddenPublicId), 'unlisted chapters must not appear in the sitemap');
  // ...while still being readable by anyone holding the URL
  const direct = await app.request(`/api/reader/works/${hiddenPublicId}`);
  assert.equal(direct.status, 200);
});

test('SEO-09: SITE_ORIGIN, when set, overrides the request Host', async () => {
  // the configured origin is what crawlers are told, so a forged Host cannot
  // inject itself into the sitemap
  const forged = await app.request('/sitemap-pages.xml', { headers: { host: 'evil.example' } });
  const body = await forged.text();
  if (process.env.SITE_ORIGIN) {
    assert.ok(body.includes(process.env.SITE_ORIGIN), 'configured origin wins');
    assert.ok(!body.includes('evil.example'), 'forged Host must not appear');
  } else {
    // unset in dev: documented fallback, asserted so the behaviour is pinned
    assert.match(body, /<loc>https?:\/\//);
  }
});
