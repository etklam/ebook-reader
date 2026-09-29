// L2 E2E acceptance (dev-plan §22A): the M2 first-import vertical slice
// against real PostgreSQL + real private storage — upload → queue → worker
// parse → staging → admin preview → commit → canonical draft work. No mocks:
// the Hono app is exercised via app.request, the worker via runOnce, and the
// fault injection uses a real DB trigger created by the migrator role.
//
// Run: pnpm --filter server test:e2e   (needs `pnpm db:up` + `pnpm db:migrate`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import { Pool } from 'pg';

// storage root must be isolated before importing the app (module-level const)
process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-'));
const { app } = await import('../src/index.ts');
const { runOnce } = await import('../src/import/queue.ts');
const { localStorage } = await import('../src/storage.ts');
const { hashPassword } = await import('../src/auth/password.ts');

const storage = localStorage(process.env.STORAGE_ROOT);
const FIXTURES = fileURLToPath(new URL('../../m0/fixtures/txt', import.meta.url));
const SUFFIX = Math.random().toString(36).slice(2, 8);

// worker pool: the worker role claims jobs (role separation is part of the test)
const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const migratorPool = new Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL ?? '', max: 1 });
const { makeDb } = await import('../src/db/client.ts');
const workerDb = makeDb(workerPool);

const BASE = readFileSync(join(FIXTURES, 'base-180.txt'));

// --- helpers -------------------------------------------------------------------
async function login(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, 'login should succeed');
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

function upload(file: File, cookie: string, extra?: Record<string, string>) {
  const form = new FormData();
  form.append('file', file);
  for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v);
  return app.request('/api/admin/imports', { method: 'POST', headers: { cookie }, body: form });
}

async function uploadAndProcess(name: string, bytes: Buffer | string, cookie: string, extra?: Record<string, string>) {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  const res = await upload(new File([buf], name), cookie, extra);
  assert.equal(res.status, 201, `upload ${name} should be accepted`);
  const { importId } = await res.json() as { importId: string };
  const processed = await runOnce(workerDb, storage, `e2e-${SUFFIX}`);
  assert.equal(processed, importId, 'worker should claim exactly this job');
  return importId;
}

async function q(sql: string, params: unknown[] = []) {
  const res = await workerPool.query(sql, params);
  return res.rows;
}

let admin = '';
let member = '';

before(async () => {
  // clean leftovers from aborted previous runs: stale queued/failed jobs would
  // be claimed ahead of this run's uploads (FIFO by created_at)
  await q(`delete from app.import_items where import_job_id in (
    select id from app.import_jobs where status in ('queued','failed') and created_at < now() + interval '5 minutes')`);
  await q(`delete from app.import_jobs where status in ('queued','failed') and created_at < now() + interval '5 minutes'`);
  await q(`delete from app.source_files s where not exists (select 1 from app.import_jobs j where j.source_file_id = s.id) and s.created_at < now() + interval '5 minutes'`);
  // users (admin + member) via the API's own hashing
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
  const email = (role: string) => `e2e-${role}-${SUFFIX}@example.test`;
  for (const role of ['admin', 'member'] as const) {
    await pool.query(
      `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,$4)`,
      [`e2e-${role}-${SUFFIX}`, email(role), await hashPassword('pw-12345678'), role]);
  }
  await pool.end();
  admin = await login(email('admin'), 'pw-12345678');
  member = await login(email('member'), 'pw-12345678');
});

after(async () => {
  // FK-order teardown of everything this run created
  const works = await q(`select id from app.works where title like '%' || $1 || '%'`, [SUFFIX]);
  for (const w of works) {
    await q(`update app.chapters set head_revision_id=null where work_id=$1`, [w.id]);
    await q(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [w.id]);
    await q(`delete from app.chapters where work_id=$1`, [w.id]);
    await q(`delete from app.works where id=$1`, [w.id]);
  }
  const jobs = await q(`select id from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%'||$1||'%' or email like '%'||$2||'%')`, [`admin-${SUFFIX}`, `member-${SUFFIX}`]);
  for (const j of jobs) {
    await q(`delete from app.import_items where import_job_id=$1`, [j.id]);
    await q(`delete from app.import_jobs where id=$1`, [j.id]);
  }
  await q(`delete from app.source_files where work_id is null and created_at > now() - interval '1 hour'`);
  await q(`delete from app.sessions where user_id in (select id from app.users where email like '%'||$1||'%')`, [SUFFIX]);
  await q(`delete from app.users where email like '%'||$1||'%'`, [SUFFIX]);
  await q(`drop trigger if exists e2e_fail_on_ch100 on app.chapters`);
  await workerPool.end(); await migratorPool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

// --- the main acceptance path: base-180.txt end to end -------------------------
test('IMP-E2E: upload base-180.txt → queue → parse → preview → commit → 180 draft chapters', async () => {
  // 14. non-admin cannot upload
  const memberUpload = await upload(new File([BASE], 'base-180.txt'), member);
  assert.equal(memberUpload.status, 403);
  const anonUpload = await upload(new File([BASE], 'base-180.txt'), '');
  assert.equal(anonUpload.status, 403);

  // 1. admin uploads; 2. job enters queue
  const res = await upload(new File([BASE], 'base-180.txt'), admin, { title: `e2e-${SUFFIX}` });
  assert.equal(res.status, 201);
  const { importId } = await res.json() as { importId: string };
  const queued = await q(`select status, detected_format from app.import_jobs where id=$1`, [importId]);
  assert.equal(queued[0].status, 'queued');
  assert.equal(queued[0].detected_format, 'txt');

  // 14. member cannot inspect or commit
  assert.equal((await app.request(`/api/admin/imports/${importId}`, { headers: { cookie: member } })).status, 403);
  assert.equal((await app.request(`/api/admin/imports/${importId}/commit`, { method: 'POST', headers: { cookie: member, 'content-type': 'application/json' }, body: '{}' })).status, 403);

  // 3. worker processes it
  const claim = await runOnce(workerDb, storage, `e2e-${SUFFIX}`);
  assert.equal(claim, importId);

  // 5. admin preview
  const previewRes = await app.request(`/api/admin/imports/${importId}`, { headers: { cookie: admin } });
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json() as any;
  assert.equal(preview.status, 'ready', JSON.stringify(preview.encodingResult));
  assert.equal(preview.detectedEncoding, 'utf-8');
  assert.equal(preview.stagedChapters, 180);

  // paginated chapter list
  const page1 = await (await app.request(`/api/admin/imports/${importId}/chapters?limit=100&page=1`, { headers: { cookie: admin } })).json() as any;
  const page2 = await (await app.request(`/api/admin/imports/${importId}/chapters?limit=100&page=2`, { headers: { cookie: admin } })).json() as any;
  assert.equal(page1.total, 180);
  assert.equal(page1.chapters.length, 100);
  assert.equal(page2.chapters.length, 80);
  assert.equal(page1.chapters[0].labelRaw, '第1章');
  assert.equal(page1.chapters[0].title, '起風');
  assert.ok(page1.chapters[0].snippet.length > 0 && page1.chapters[0].snippet.length <= 120);

  // 7–13. explicit commit → canonical draft state, idempotent retry
  const commitRes = await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `驗收${SUFFIX}` }),
  });
  assert.equal(commitRes.status, 200);
  const commit1 = await commitRes.json() as any;
  assert.equal(commit1.chapterCount, 180);
  assert.equal(commit1.alreadyCommitted, false);

  // retry the same commit: same result, no duplicates
  const commit2 = await (await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `驗收${SUFFIX}` }),
  })).json() as any;
  assert.equal(commit2.workId, commit1.workId);
  assert.equal(commit2.chapterCount, 180);
  assert.equal(commit2.alreadyCommitted, true);

  // 7. exactly 180 canonical chapters; 8. one initial revision each;
  // 9. head_revision_id belongs to the same chapter; 10. labels verbatim;
  // 11. ordering; 12. work stays draft
  const stats = await q(`
    select
      (select count(*) from app.chapters where work_id=$1)::int as chapters,
      (select count(*) from app.chapter_revisions r join app.chapters c on c.id=r.chapter_id where c.work_id=$1)::int as revisions,
      (select count(*) from app.chapters c join app.chapter_revisions r on r.id=c.head_revision_id where c.work_id=$1 and r.chapter_id<>c.id)::int as bad_heads,
      (select visibility from app.works where id=$1) as visibility,
      (select status from app.import_jobs where committed_work_id=$1) as job_status`, [commit1.workId]);
  assert.equal(stats[0].chapters, 180);
  assert.equal(stats[0].revisions, 180);
  assert.equal(stats[0].bad_heads, 0);
  assert.equal(stats[0].visibility, 'draft');
  assert.equal(stats[0].job_status, 'committed');

  const rows = await q(
    `select c.editorial_position, c.label_raw, c.head_revision_id is not null as has_head
     from app.chapters c where c.work_id=$1 order by c.editorial_position`, [commit1.workId]);
  assert.equal(rows.length, 180);
  for (let i = 0; i < 180; i++) {
    assert.equal(rows[i].editorial_position, i + 1);
    assert.equal(rows[i].label_raw, `第${i + 1}章`);
    assert.ok(rows[i].has_head);
  }

  // revision bodies point at real immutable storage objects
  const revs = await q(
    `select r.content_key from app.chapter_revisions r join app.chapters c on c.id=r.chapter_id
     where c.work_id=$1 and r.content_key like '__/%' limit 5`, [commit1.workId]);
  assert.equal(revs.length, 5);
  for (const r of revs) {
    const body = await storage.get(r.content_key);
    assert.ok(body.length > 0);
  }
});

// --- IMP-14: encoding fixtures reach the same staging path ----------------------
test('IMP-14: UTF-16 / Big5 / GB18030 uploads detect and parse', async () => {
  const sample = '第1章 起\n\n他們來到這裡，說起從前的往事。\n\n第2章 承\n\n後來門關上了。\n';
  const simp = '第1章 起\n\n他们来到这里，说起从前的往事。\n\n第2章 承\n\n后来门关上了。\n';
  const cases: Array<[string, Buffer, string]> = [
    ['u16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(sample, 'utf-16le')]), 'utf-16le'],
    ['big5.txt', iconv.encode(sample, 'big5'), 'big5'],
    ['gb.txt', iconv.encode(simp, 'gb18030'), 'gb18030'],
  ];
  for (const [name, bytes, expected] of cases) {
    const importId = await uploadAndProcess(name, bytes, admin);
    const job = await q(`select status, detected_encoding, chapter_count from app.import_jobs where id=$1`, [importId]);
    assert.equal(job[0].detected_encoding, expected, name);
    assert.equal(job[0].chapter_count, 2, name);
    assert.equal(job[0].status, 'ready', name);
    const items = await q(`select label_raw from app.import_items where import_job_id=$1 order by position`, [importId]);
    assert.deepEqual(items.map((i) => i.label_raw), ['第1章', '第2章']);
  }
});

// --- IMP-05: weird labels survive commit with no numeric coercion ---------------
test('IMP-05: weird labels commit verbatim', async () => {
  const importId = await uploadAndProcess('weird-labels.txt', readFileSync(join(FIXTURES, 'weird-labels.txt')), admin);
  const commit = await (await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `奇怪${SUFFIX}` }),
  })).json() as any;
  const rows = await q(
    `select label_raw from app.chapters where work_id=$1 order by editorial_position`, [commit.workId]);
  assert.deepEqual(rows.map((r) => r.label_raw), [
    '序章', '第12.5章', '第12.10章', '第12.5.1章', '第12章（上）',
    '第12章（下）', '第012章', '番外1.5', '風起', '終章',
  ]);
});

// --- upload guard rails ----------------------------------------------------------
test('SEC: unsupported extension rejected, member 403', async () => {
  const bad = await upload(new File([Buffer.from('x')], 'virus.exe'), admin);
  assert.equal(bad.status, 415);
});

// --- EPUB is accepted and stored, parsing explicitly deferred (documented) ------
test('EPUB: upload persists the source; parsing reports EPUB_NOT_IMPLEMENTED, not silent success', async () => {
  const epub = readFileSync(fileURLToPath(new URL('../../m0/fixtures/sample.epub', import.meta.url)));
  const importId = await uploadAndProcess('sample.epub', epub, admin);
  const job = await q(`select status, error_code from app.import_jobs where id=$1`, [importId]);
  assert.equal(job[0].status, 'failed');
  assert.equal(job[0].error_code, 'EPUB_NOT_IMPLEMENTED');
});

// --- IMP-12: failure safety ------------------------------------------------------
test('IMP-12a: commit before processing is rejected, nothing canonical created', async () => {
  const res = await upload(new File([readFileSync(join(FIXTURES, 'partial-1-170.txt'))], 'p.txt'), admin);
  const { importId } = await res.json() as { importId: string };
  const commit = await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(commit.status, 409);
  const n = await q(`select count(*)::int as n from app.chapters c join app.import_jobs j on j.committed_work_id=c.work_id where j.id=$1`, [importId]);
  assert.equal(n[0].n, 0);
  // drain the queue so later tests' uploads are claimed in order
  const drained = await runOnce(workerDb, storage, `e2e-${SUFFIX}`);
  assert.equal(drained, importId);
});

test('IMP-12b: mid-commit DB failure rolls back completely, job stays retryable', async () => {
  const importId = await uploadAndProcess('p170.txt', readFileSync(join(FIXTURES, 'partial-1-170.txt')), admin);

  // fault injection: fail when the transaction reaches chapter 100
  await migratorPool.query(`
    create or replace function e2e_fail_100() returns trigger as $$
    begin
      if new.editorial_position = 100 then
        raise exception 'injected failure at chapter 100';
      end if;
      return new;
    end $$ language plpgsql`);
  await migratorPool.query(`grant execute on function e2e_fail_100() to ebook_api`);
  await migratorPool.query(`drop trigger if exists e2e_fail_on_ch100 on app.chapters`);
  await migratorPool.query(`create trigger e2e_fail_on_ch100 before insert on app.chapters for each row execute function e2e_fail_100()`);

  try {
    const commit = await app.request(`/api/admin/imports/${importId}/commit`, {
      method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ title: `失敗${SUFFIX}` }),
    });
    assert.equal(commit.status, 500);

    // no half-created book: 0 chapters, 0 revisions, no new work, job inspectable
    const stats = await q(`
      select
        (select count(*) from app.works where title=$1)::int as works,
        (select count(*) from app.chapters c join app.import_jobs j on j.committed_work_id=c.work_id where j.id=$2)::int as chapters,
        (select count(*) from app.chapter_revisions r join app.chapters c on c.id=r.chapter_id where c.work_id in (select id from app.works where title=$1))::int as revisions,
        (select status from app.import_jobs where id=$2) as status`, [`失敗${SUFFIX}`, importId]);
    assert.equal(stats[0].works, 0, 'no work row should survive');
    assert.equal(stats[0].chapters, 0, 'no chapters should survive');
    assert.equal(stats[0].revisions, 0, 'no revisions should survive');
    assert.equal(stats[0].status, 'ready', 'job stays committable');
    const still = await app.request(`/api/admin/imports/${importId}`, { headers: { cookie: admin } });
    assert.equal(still.status, 200, 'staging remains inspectable');
  } finally {
    await migratorPool.query(`drop trigger if exists e2e_fail_on_ch100 on app.chapters`);
    await migratorPool.query(`drop function if exists e2e_fail_100()`);
  }

  // retry now succeeds and is complete
  const retry = await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `失敗重試${SUFFIX}` }),
  });
  assert.equal(retry.status, 200);
  const body = await retry.json() as any;
  assert.equal(body.chapterCount, 170);
});
