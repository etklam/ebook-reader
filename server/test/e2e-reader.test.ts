// L2 E2E acceptance (M5 reader APIs, READ backend gate): work metadata,
// ordered TOC with verbatim irregular labels, head-revision-only chapter
// content, draft visibility rules, and no internal-field leakage. Reuses the
// real import pipeline (upload → worker → commit) so the reader is exercised
// against genuinely committed canonical data.
//
// Run: pnpm --filter server test:e2e   (needs `pnpm db:up` + `pnpm db:migrate`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-reader-'));
const { app } = await import('../src/index.ts');
const { runOnce } = await import('../src/import/queue.ts');
const { localStorage } = await import('../src/storage.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const { makeDb } = await import('../src/db/client.ts');

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
    const processed = await runOnce(workerDb, storage, { owner: `e2e-r-${SUFFIX}`, leaseMs: 300_000, heartbeatMs: 100_000, maxAttempts: 3, storageConcurrency: 6 });
    if (processed === importId) return;
    const rows = await q(`select status from app.import_jobs where id=$1`, [importId]);
    if (rows[0] && !['queued', 'processing'].includes(rows[0].status)) return;
    if (!processed) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${importId} was never claimed`);
}

async function uploadAndCommit(name: string, bytes: Buffer, cookie: string, title: string): Promise<string> {
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

let admin = '';
let member = '';
let weirdWork = '';   // draft (default) — irregular labels
let baseWork = '';    // made public — 180 plain chapters
let weirdChapterIds: string[] = [];

before(async () => {
  await q(`delete from app.import_items where import_job_id in (
    select id from app.import_jobs where status in ('queued','failed') and created_at < now() + interval '5 minutes')`);
  await q(`delete from app.import_jobs where status in ('queued','failed') and created_at < now() + interval '5 minutes'`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
  const email = (role: string) => `e2e-r-${role}-${SUFFIX}@example.test`;
  for (const role of ['admin', 'member'] as const) {
    await pool.query(
      `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,$4)`,
      [`e2e-r-${role}-${SUFFIX}`, email(role), await hashPassword('pw-12345678'), role]);
  }
  await pool.end();
  admin = await login(`e2e-r-admin-${SUFFIX}@example.test`, 'pw-12345678');
  member = await login(`e2e-r-member-${SUFFIX}@example.test`, 'pw-12345678');

  weirdWork = await uploadAndCommit('weird-labels.txt', readFileSync(join(FIXTURES, 'weird-labels.txt')), admin, `讀者測試-怪標籤-${SUFFIX}`);
  baseWork = await uploadAndCommit('base-180.txt', readFileSync(join(FIXTURES, 'base-180.txt')), admin, `讀者測試-Base-${SUFFIX}`);
  // stays draft+unpublished: since M6, public works need an active release —
  // head exposure for drafts is Admin preview only (covered against head here)

  weirdChapterIds = (await q(`select id from app.chapters where work_id=$1 order by editorial_position`, [weirdWork])).map((r: { id: string }) => r.id);
});

after(async () => {
  for (const w of [...(await q(`select id from app.works where title like '%' || $1 || '%'`, [SUFFIX]))]) {
    await q(`update app.chapters set head_revision_id=null where work_id=$1`, [w.id]);
    await q(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [w.id]);
    await q(`delete from app.chapters where work_id=$1`, [w.id]);
    await q(`delete from app.works where id=$1`, [w.id]);
  }
  const jobs = await q(`select id from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%'||$1||'%' or email like '%'||$2||'%')`, [`r-admin-${SUFFIX}`, `r-member-${SUFFIX}`]);
  for (const j of jobs) {
    await q(`delete from app.import_items where import_job_id=$1`, [j.id]);
    await q(`delete from app.import_jobs where id=$1`, [j.id]);
  }
  await q(`delete from app.source_files s where not exists (select 1 from app.import_jobs j where j.source_file_id = s.id) and s.created_at > now() - interval '1 hour'`);
  for (const suffix of [`r-admin-${SUFFIX}`, `r-member-${SUFFIX}`]) {
    await q(`delete from app.sessions where user_id in (select id from app.users where email like '%'||$1||'%')`, [suffix]);
    await q(`delete from app.users where email like '%'||$1||'%'`, [suffix]);
  }
  workerPool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

test('READ-API: work metadata — chapterCount and first/latest ids', async () => {
  const res = await app.request(`/api/reader/works/${weirdWork}`, { headers: { cookie: admin } });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.title, `讀者測試-怪標籤-${SUFFIX}`);
  assert.equal(body.workType, 'serial');
  assert.equal(body.visibility, 'draft');
  assert.equal(body.chapterCount, 10);
  assert.equal(body.firstChapterId, weirdChapterIds[0]);
  assert.equal(body.latestChapterId, weirdChapterIds[9]);
  // reader DTO stays small: no import/admin internals
  for (const forbidden of ['storageKey', 'contentKey', 'sourceFileId', 'sourceImportId', 'editVersion', 'bodyCompareHash']) {
    assert.ok(!(forbidden in body), `work DTO must not expose ${forbidden}`);
  }
});

test('READ-API: draft visibility — admin only; public readable anonymously; removed/unknown 404', async () => {
  // draft: member and anonymous are forbidden
  assert.equal((await app.request(`/api/reader/works/${weirdWork}`, { headers: { cookie: member } })).status, 403);
  assert.equal((await app.request(`/api/reader/works/${weirdWork}`)).status, 403);
  // public WITHOUT an active release exposes nothing (M6 §8 — never the head);
  // flip back to draft afterwards so Admin head preview keeps working below
  await q(`update app.works set visibility='public' where id=$1`, [baseWork]);
  const unreleased = await app.request(`/api/reader/works/${baseWork}`);
  assert.equal(unreleased.status, 200);
  assert.equal(((await unreleased.json()) as { chapterCount: number }).chapterCount, 0);
  const unreleasedToc = await app.request(`/api/reader/works/${baseWork}/chapters`);
  assert.equal(((await unreleasedToc.json()) as { total: number }).total, 0);
  await q(`update app.works set visibility='draft' where id=$1`, [baseWork]);
  // unknown and removed both 404
  assert.equal((await app.request(`/api/reader/works/00000000-0000-0000-0000-000000000000`)).status, 404);
  await q(`update app.works set visibility='removed' where id=$1`, [weirdWork]);
  assert.equal((await app.request(`/api/reader/works/${weirdWork}`, { headers: { cookie: admin } })).status, 404);
  await q(`update app.works set visibility='draft' where id=$1`, [weirdWork]);
});

test('READ-API: TOC is ordered, labels verbatim, paginated, no bodies', async () => {
  const res = await app.request(`/api/reader/works/${weirdWork}/chapters`, { headers: { cookie: admin } });
  assert.equal(res.status, 200);
  const body = await res.json() as { total: number; chapters: Array<{ id: string; labelRaw: string; title: string; editorialPosition: number; revisionId: string | null; volumeId: string | null }> };
  assert.equal(body.total, 10);
  assert.equal(body.chapters.length, 10);
  // verbatim irregular labels, source order, never numerically normalized
  assert.deepEqual(body.chapters.map((c) => c.labelRaw), [
    '序章', '第12.5章', '第12.10章', '第12.5.1章', '第12章（上）', '第12章（下）', '第012章', '番外1.5', '風起', '終章',
  ]);
  assert.deepEqual(body.chapters.map((c) => c.editorialPosition), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const c of body.chapters) {
    assert.ok(c.revisionId, 'every committed chapter has a head revision');
    assert.ok(!('body' in c), 'TOC must not carry chapter bodies');
  }
  // pagination window (draft work previewed by Admin = editorial head)
  const page = await app.request(`/api/reader/works/${baseWork}/chapters?limit=50&offset=50`, { headers: { cookie: admin } });
  const pb = await page.json() as { total: number; limit: number; offset: number; chapters: Array<{ editorialPosition: number }> };
  assert.equal(pb.total, 180);
  assert.equal(pb.limit, 50);
  assert.equal(pb.chapters.length, 50);
  assert.equal(pb.chapters[0].editorialPosition, 51);
  // limit is capped so a huge limit cannot fetch everything at once
  const capped = await app.request(`/api/reader/works/${baseWork}/chapters?limit=99999`, { headers: { cookie: admin } });
  assert.equal(((await capped.json()) as { limit: number }).limit, 500);
  void capped;
});

test('READ-API: chapter content — head revision body, neighbors, paragraph count', async () => {
  const res = await app.request(`/api/reader/chapters/${weirdChapterIds[1]}`, { headers: { cookie: admin } });
  assert.equal(res.status, 200);
  const ch = await res.json() as {
    chapterId: string; workId: string; revisionId: string; labelRaw: string; title: string;
    body: string; previousChapterId: string | null; nextChapterId: string | null;
    paragraphCount: number; updatedAt: string;
  };
  assert.equal(ch.chapterId, weirdChapterIds[1]);
  assert.equal(ch.workId, weirdWork);
  assert.equal(ch.labelRaw, '第12.5章');
  assert.equal(ch.previousChapterId, weirdChapterIds[0]);
  assert.equal(ch.nextChapterId, weirdChapterIds[2]);
  assert.ok(ch.body.includes('岔路') === false && ch.body.length > 0, 'body is canonical text');
  assert.equal(ch.paragraphCount, ch.body.split('\n\n').length);
  // head revision id matches the DB, and the DTO leaks no storage fields
  const dbRows = await q(`select head_revision_id from app.chapters where id=$1`, [weirdChapterIds[1]]);
  assert.equal(ch.revisionId, dbRows[0].head_revision_id);
  assert.ok(!('contentKey' in ch) && !('storageKey' in ch));
});

test('READ-API: chapter follows head revision moves; missing head → content_unavailable', async () => {
  const before = await (await app.request(`/api/reader/chapters/${weirdChapterIds[0]}`, { headers: { cookie: admin } })).json() as { revisionId: string; body: string };
  // simulate an overwrite: new immutable revision becomes head
  const [rev] = await q(
    `insert into app.chapter_revisions (chapter_id, title, content_key, body_compare_hash, revision_hash, processor_version)
     values ($1,'序章（修訂）',(select content_key from app.chapter_revisions where id=$2),'x','x','txt-v1') returning id`,
    [weirdChapterIds[0], before.revisionId]);
  await q(`update app.chapters set head_revision_id=$1 where id=$2`, [rev.id, weirdChapterIds[0]]);
  const after = await (await app.request(`/api/reader/chapters/${weirdChapterIds[0]}`, { headers: { cookie: admin } })).json() as { revisionId: string; title: string };
  assert.equal(after.revisionId, rev.id);
  assert.equal(after.title, '序章（修訂）');
  // head removed → predictable 409, not a storage error
  await q(`update app.chapters set head_revision_id=null where id=$1`, [weirdChapterIds[0]]);
  assert.equal((await app.request(`/api/reader/chapters/${weirdChapterIds[0]}`, { headers: { cookie: admin } })).status, 409);
  // restore
  await q(`update app.chapters set head_revision_id=$1 where id=$2`, [rev.id, weirdChapterIds[0]]);
});

test('READ-API: unknown chapter and malformed ids', async () => {
  assert.equal((await app.request(`/api/reader/chapters/00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await app.request(`/api/reader/chapters/not-a-uuid`)).status, 404);
});
