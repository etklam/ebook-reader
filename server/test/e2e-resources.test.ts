// L2 E2E acceptance (Phase 2 / ADR-08 / IMP-17): images, footnotes and
// resource-aware revision detection, end to end.
//
//   RES-01  an illustrated EPUB imports with its images, content-addressed
//   RES-02  footnote text is preserved, not silently dropped
//   RES-03  an unsupported image type warns and is skipped, never dropped
//           silently and never stored
//   RES-04  the reader API returns a per-revision resource manifest and serves
//           the bytes
//   RES-05  resource authorization is by reachability, not by knowing the hash
//   RES-06  IMP-17: identical prose with a different image is `modified`, and
//           overwrite produces a new revision with the new resource set
//   RES-07  publish refuses when a referenced image object is missing
//   RES-08  the orphan sweep never deletes a referenced image
//
// Run: pnpm --filter server test:e2e   (needs `pnpm db:up` + `pnpm db:migrate`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-res-'));
const { app } = await import('../src/index.ts');
const { runOnce } = await import('../src/import/queue.ts');
const { localStorage } = await import('../src/storage.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const { makeDb } = await import('../src/db/client.ts');
const { sweepStorage } = await import('../src/maintenance/reclaim.ts');

const storage = localStorage(process.env.STORAGE_ROOT);
const FIXTURES = fileURLToPath(new URL('../../m0/fixtures', import.meta.url));
const SUFFIX = Math.random().toString(36).slice(2, 8);
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const db = makeDb(pool);
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

let admin = '';
let member = '';
let workId = '';
let categoryId = '';

async function login(email: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw-12345678' }),
  });
  assert.equal(res.status, 200);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

async function processUntil(importId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const processed = await runOnce(db, storage, {
      owner: `e2e-res-${SUFFIX}`, leaseMs: 300_000, heartbeatMs: 100_000,
      maxAttempts: 3, storageConcurrency: 6,
    });
    if (processed === importId) return;
    const rows = await q(`select status from app.import_jobs where id=$1`, [importId]);
    if (rows[0] && !['queued', 'processing'].includes(rows[0].status)) return;
    if (!processed) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${importId} was never claimed`);
}

async function upload(fixture: string, targetWorkId?: string): Promise<string> {
  const form = new FormData();
  form.append('file', new File([readFileSync(join(FIXTURES, fixture))], fixture));
  if (targetWorkId) form.append('workId', targetWorkId);
  const res = await app.request('/api/admin/imports', {
    method: 'POST', headers: { cookie: admin }, body: form,
  });
  const text = await res.text();
  assert.equal(res.status, 201, `upload ${fixture} → ${res.status} ${text}`);
  const { importId } = JSON.parse(text) as { importId: string };
  await processUntil(importId);
  return importId;
}

before(async () => {
  for (const role of ['admin', 'member'] as const) {
    await q(`insert into app.users (username, email, password_hash, role) values ($1,$2,$3,$4)`,
      [`e2e-res-${role}-${SUFFIX}`, `e2e-res-${role}-${SUFFIX}@example.test`,
        await hashPassword('pw-12345678'), role]);
  }
  admin = await login(`e2e-res-admin-${SUFFIX}@example.test`);
  member = await login(`e2e-res-member-${SUFFIX}@example.test`);
  [{ id: categoryId }] = await q(
    `insert into app.categories (display_name) values ($1) returning id`, [`插圖分類-${SUFFIX}`]);

  const importId = await upload('sample-illustrated.epub');
  const commit = await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ title: `插圖樣本-${SUFFIX}`, workType: 'serial' }),
  });
  const commitText = await commit.text();
  assert.equal(commit.status, 200, commitText);
  workId = (JSON.parse(commitText) as { workId: string }).workId;
  await q(`update app.works set serial_status='ongoing', visibility='public' where id=$1`, [workId]);
  await q(`insert into app.work_categories (work_id, category_id) values ($1,$2)`, [workId, categoryId]);
});

after(async () => {
  const works = await q(`select id from app.works where title like '%'||$1||'%'`, [SUFFIX]);
  for (const w of works) {
    await q(`update app.works set active_release_id=null where id=$1`, [w.id]);
    await q(`delete from app.publication_events where work_id=$1`, [w.id]);
    await q(`delete from app.release_items where release_id in
             (select id from app.work_releases where work_id=$1)`, [w.id]);
    await q(`delete from app.work_releases where work_id=$1`, [w.id]);
    await q(`delete from app.work_categories where work_id=$1`, [w.id]);
    await q(`update app.chapters set head_revision_id=null where work_id=$1`, [w.id]);
    await q(`delete from app.chapter_revision_resources where revision_id in
             (select cr.id from app.chapter_revisions cr
              join app.chapters c on c.id=cr.chapter_id where c.work_id=$1)`, [w.id]);
    await q(`delete from app.chapter_revisions where chapter_id in
             (select id from app.chapters where work_id=$1)`, [w.id]);
    await q(`delete from app.chapters where work_id=$1`, [w.id]);
    await q(`update app.source_files set work_id=null where work_id=$1`, [w.id]);
    await q(`update app.import_jobs set work_id=null, committed_work_id=null
             where work_id=$1 or committed_work_id=$1`, [w.id]);
    await q(`delete from app.works where id=$1`, [w.id]);
  }
  const jobs = await q(
    `select id from app.import_jobs where requested_by_user_id in
     (select id from app.users where email like $1)`, [`e2e-res-%-${SUFFIX}@example.test`]);
  for (const j of jobs) {
    await q(`delete from app.apply_idempotency where import_job_id=$1`, [j.id]);
    await q(`delete from app.import_item_resources where import_item_id in
             (select id from app.import_items where import_job_id=$1)`, [j.id]);
    await q(`delete from app.import_items where import_job_id=$1`, [j.id]);
    await q(`delete from app.import_jobs where id=$1`, [j.id]);
  }
  await q(`delete from app.categories where id=$1`, [categoryId]);
  await q(`delete from app.sessions where user_id in
           (select id from app.users where email like $1)`, [`e2e-res-%-${SUFFIX}@example.test`]);
  await q(`delete from app.users where email like $1`, [`e2e-res-%-${SUFFIX}@example.test`]);
  await pool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

test('RES-01: images import content-addressed, one object per distinct image', async () => {
  const chapters = await q(
    `select c.id, c.label_raw, cr.id as revision_id, cr.content_key
     from app.chapters c join app.chapter_revisions cr on cr.id = c.head_revision_id
     where c.work_id = $1 order by c.editorial_position`, [workId]);
  assert.equal(chapters.length, 3);

  const links = await q(
    `select rr.revision_id, rr.content_hash, rr.alt, r.media_type, r.size_bytes
     from app.chapter_revision_resources rr
     join app.resources r on r.id = rr.resource_id
     where rr.revision_id = any($1)`, [chapters.map((c) => c.revision_id)]);
  // two distinct images across the book (plate-a, plate-b); the SVG is skipped
  assert.equal(new Set(links.map((l) => l.content_hash)).size, 2, 'two distinct images');
  for (const l of links) assert.equal(l.media_type, 'image/png');

  // plate-a is referenced from chapter 2 (twice) and chapter 3 — the
  // association table is keyed (revision, hash) so it is one row per revision,
  // while the body carries a marker per occurrence
  const ch2 = chapters[1];
  const body2 = (await storage.get(ch2.content_key)).toString('utf8');
  assert.equal((body2.match(/\[\[img:/g) ?? []).length, 2,
    'an image placed twice by the author yields two markers');

  // storage holds ONE object per distinct image, not one per reference
  const objects = await q(`select count(*)::int n from app.resources where content_hash = any($1)`,
    [[...new Set(links.map((l) => l.content_hash))]]);
  assert.equal(objects[0].n, 2);

  // every marker in every body resolves to a row for that same revision
  for (const ch of chapters) {
    const body = (await storage.get(ch.content_key)).toString('utf8');
    const hashes = [...body.matchAll(/\[\[img:([0-9a-f]{64})/g)].map((m) => m[1]);
    for (const h of hashes) {
      assert.ok(links.some((l) => l.revision_id === ch.revision_id && l.content_hash === h),
        `marker ${h.slice(0, 12)} in ${ch.label_raw} has no association row`);
    }
  }
});

test('RES-02: footnote text is preserved as an endnote, not dropped', async () => {
  const [ch2] = await q(
    `select cr.content_key from app.chapters c
     join app.chapter_revisions cr on cr.id = c.head_revision_id
     where c.work_id = $1 and c.editorial_position = 2`, [workId]);
  const body = (await storage.get(ch2.content_key)).toString('utf8');
  assert.match(body, /\[註 1\]/, 'an inline marker replaces the noteref');
  assert.match(body, /這是第一條註腳的內容/, 'the note text survives import');

  const items = await q(
    `select warnings from app.import_items i
     join app.import_jobs j on j.id = i.import_job_id
     where j.committed_work_id = $1 and i.position = 1`, [workId]);
  assert.ok((items[0].warnings as string[]).includes('footnotes_appended'),
    'the Admin is told footnotes were relocated');
});

test('RES-03: an unsupported image type warns and stores nothing', async () => {
  const [job] = await q(
    `select encoding_result from app.import_jobs where committed_work_id = $1`, [workId]);
  const warnings = (job.encoding_result as { warnings: string[] }).warnings;
  assert.ok(warnings.some((w) => w.includes('不支援的圖片格式')),
    `expected an unsupported-format warning, got ${JSON.stringify(warnings)}`);
  // and no SVG was stored
  const svg = await q(`select count(*)::int n from app.resources where media_type like '%svg%'`);
  assert.equal(svg[0].n, 0, 'SVG is never stored');
});

test('RES-04: the reader serves a per-revision manifest and the image bytes', async () => {
  const pub = await app.request(`/api/admin/works/${workId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': `res-${SUFFIX}` },
    body: '{}',
  });
  assert.equal(pub.status, 200, await pub.text());
  const [first] = await q(
    `select ri.chapter_id from app.release_items ri
     join app.works w on w.active_release_id = ri.release_id
     where w.id = $1 order by ri.editorial_position limit 1`, [workId]);

  const res = await app.request(`/api/reader/chapters/${first.chapter_id}`);
  assert.equal(res.status, 200);
  const chapter = await res.json() as {
    body: string;
    resources: Array<{ contentHash: string; url: string; mediaType: string; alt: string }>;
  };
  assert.equal(chapter.resources.length, 1);
  const resource = chapter.resources[0];
  assert.ok(chapter.body.includes(`[[img:${resource.contentHash}`), 'the marker matches the manifest');
  assert.equal(resource.alt, '天橋遠景', 'alt text survives to the reader');

  const bytes = await app.request(resource.url);
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get('content-type'), 'image/png');
  assert.equal(bytes.headers.get('x-content-type-options'), 'nosniff');
  // content-addressed URLs are immutable, so they override the API's no-store
  assert.match(bytes.headers.get('cache-control') ?? '', /immutable/);
  const buf = Buffer.from(await bytes.arrayBuffer());
  assert.ok(buf.length > 0);
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', 'real PNG bytes are served');
});

test('RES-05: resource access is by reachability, not by knowing the hash', async () => {
  assert.equal((await app.request('/api/reader/resources/not-a-hash')).status, 404);
  assert.equal((await app.request(`/api/reader/resources/${'0'.repeat(64)}`)).status, 404);

  // a draft-only work's image must not be fetchable by hash
  const draftImport = await upload('sample-illustrated-v2.epub');
  const commit = await app.request(`/api/admin/imports/${draftImport}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ title: `草稿插圖-${SUFFIX}`, workType: 'serial' }),
  });
  const draftText = await commit.text();
  assert.equal(commit.status, 200, draftText);
  const draftWorkId = (JSON.parse(draftText) as { workId: string }).workId;
  // left as draft, never published

  const draftOnly = await q(
    `select distinct rr.content_hash
     from app.chapters c
     join app.chapter_revision_resources rr on rr.revision_id = c.head_revision_id
     where c.work_id = $1
       and not exists (
         select 1 from app.chapter_revision_resources rr2
         join app.release_items ri on ri.revision_id = rr2.revision_id
         join app.works w on w.active_release_id = ri.release_id
         where rr2.content_hash = rr.content_hash and w.visibility in ('public','unlisted'))`,
    [draftWorkId]);
  assert.ok(draftOnly.length > 0, 'the v2 fixture contributes at least one unpublished image');

  for (const row of draftOnly) {
    const anon = await app.request(`/api/reader/resources/${row.content_hash}`);
    assert.equal(anon.status, 403, 'an unpublished image is refused to the public');
    const asMember = await app.request(`/api/reader/resources/${row.content_hash}`,
      { headers: { cookie: member } });
    assert.equal(asMember.status, 403, 'and to a signed-in non-admin');
    const asAdmin = await app.request(`/api/reader/resources/${row.content_hash}`,
      { headers: { cookie: admin } });
    assert.equal(asAdmin.status, 200, 'Admin may preview it');
  }
});

test('RES-06 (IMP-17): identical prose with a different image is a revision', async () => {
  // re-import the v2 fixture against the published work. Chapter 1's prose is
  // byte-identical; only its image differs.
  const importId = await upload('sample-illustrated-v2.epub', workId);

  const diffRes = await app.request(`/api/admin/imports/${importId}/diff`, { headers: { cookie: admin } });
  const diffText = await diffRes.text();
  assert.equal(diffRes.status, 200, diffText);
  const diff = JSON.parse(diffText) as {
    editVersion: number;
    match: { items: Array<{ labelRaw: string; itemClass: string; reason: string[] }> };
  };

  // the fixture's nav text is "第N章 插圖…", so labelRaw carries the title too
  const ch1 = diff.match.items.find((i) => i.labelRaw.startsWith('第1章'));
  assert.ok(ch1, 'chapter 1 was matched');
  assert.equal(ch1!.itemClass, 'modified',
    'prose-identical but image-changed must NOT be reported as unchanged');

  // chapters 2 and 3 are untouched in v2 and must stay unchanged
  for (const label of ['第2章', '第3章']) {
    const item = diff.match.items.find((i) => i.labelRaw.startsWith(label));
    assert.equal(item?.itemClass, 'unchanged', `${label} should be unchanged`);
  }

  // overwrite: a new immutable revision on the same chapter_id, carrying the
  // new resource set
  const before = await q(
    `select c.id, c.head_revision_id from app.chapters c
     where c.work_id = $1 and c.editorial_position = 1`, [workId]);
  const applyRes = await app.request(`/api/admin/imports/${importId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': `res-ow-${SUFFIX}` },
    body: JSON.stringify({ baseEditVersion: diff.editVersion, mode: 'overwrite' }),
  });
  const applyText = await applyRes.text();
  assert.equal(applyRes.status, 200, applyText);
  const summary = JSON.parse(applyText) as { summary: { updated: number; unchanged: number } };
  assert.equal(summary.summary.updated, 1, 'exactly the image-changed chapter is updated');
  assert.equal(summary.summary.unchanged, 2);

  const after = await q(
    `select c.id, c.head_revision_id from app.chapters c
     where c.work_id = $1 and c.editorial_position = 1`, [workId]);
  assert.equal(after[0].id, before[0].id, 'chapter_id is stable (ADR-03)');
  assert.notEqual(after[0].head_revision_id, before[0].head_revision_id, 'head moved to a new revision');

  // the new revision references the NEW image; the old revision still
  // references the old one (revisions are immutable)
  const newLinks = await q(
    `select content_hash from app.chapter_revision_resources where revision_id = $1`,
    [after[0].head_revision_id]);
  const oldLinks = await q(
    `select content_hash from app.chapter_revision_resources where revision_id = $1`,
    [before[0].head_revision_id]);
  assert.equal(newLinks.length, 1);
  assert.equal(oldLinks.length, 1);
  assert.notEqual(newLinks[0].content_hash, oldLinks[0].content_hash,
    'the revision records the image it was created with');

  // revision_hash differs too, so resource changes are visible in the hash
  const hashes = await q(
    `select revision_hash from app.chapter_revisions where id = any($1)`,
    [[after[0].head_revision_id, before[0].head_revision_id]]);
  assert.equal(new Set(hashes.map((h) => h.revision_hash)).size, 2);
});

test('RES-07: publish refuses when a referenced image object is missing', async () => {
  const [res] = await q(
    `select distinct r.id, r.storage_key
     from app.chapters c
     join app.chapter_revision_resources rr on rr.revision_id = c.head_revision_id
     join app.resources r on r.id = rr.resource_id
     where c.work_id = $1 limit 1`, [workId]);
  assert.ok(res, 'the work references at least one image');

  const bytes = await storage.get(res.storage_key);
  await storage.delete(res.storage_key);
  try {
    const preview = await app.request(`/api/admin/works/${workId}/publish-preview`,
      { headers: { cookie: admin } });
    assert.equal(preview.status, 200);
    const body = await preview.json() as { valid: boolean; problems: string[] };
    assert.equal(body.valid, false);
    assert.ok(body.problems.some((p) => p.endsWith('_resource_objects_missing')),
      `expected a missing-resource problem, got ${JSON.stringify(body.problems)}`);

    const pub = await app.request(`/api/admin/works/${workId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': `res-bad-${SUFFIX}` },
      body: '{}',
    });
    assert.equal(pub.status, 400, 'publishing a visibly broken chapter is refused');
  } finally {
    // restore so later assertions and the sweep test see a consistent world
    const restored = await storage.put(bytes, 'png');
    await q(`update app.resources set storage_key = $2 where id = $1`, [res.id, restored]);
  }
});

test('RES-08: the orphan sweep never deletes a referenced image', async () => {
  const referenced = await q(
    `select distinct r.storage_key
     from app.chapters c
     join app.chapter_revision_resources rr on rr.revision_id = c.head_revision_id
     join app.resources r on r.id = rr.resource_id
     where c.work_id = $1`, [workId]);
  assert.ok(referenced.length > 0, 'this work references images');
  const r = await sweepStorage(db, storage, () => storage.list(), {
    minAgeHours: 0,        // treat everything as old enough to be a candidate
    dryRun: true,
  });
  for (const row of referenced) {
    assert.ok(!r.deleted.includes(row.storage_key),
      `sweep would delete referenced image ${row.storage_key}`);
  }
  // scoped to this work: the resources table is global and a dev database
  // carries rows from runs whose temp storage root is long gone, so a global
  // assertion would be testing fixture history rather than the sweep
  for (const row of referenced) {
    assert.ok(!r.missingPublished.includes(row.storage_key),
      `this work's published image ${row.storage_key} is reported missing`);
  }
});
