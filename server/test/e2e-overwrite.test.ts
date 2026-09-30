// L2 E2E acceptance for M4 (dev-plan §22: IMP-03, 09, 10, 13, VER-01, VER-02).
// Real PG + real storage; the Hono app is exercised via app.request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-m4-'));
const { app } = await import('../src/index.ts');
const { runOnce } = await import('../src/import/queue.ts');
const { localStorage } = await import('../src/storage.ts');
const { hashPassword } = await import('../src/auth/password.ts');

const storage = localStorage(process.env.STORAGE_ROOT);
const FIXTURES = fileURLToPath(new URL('../../m0/fixtures/txt', import.meta.url));
const SUFFIX = Math.random().toString(36).slice(2, 8);

const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const { makeDb } = await import('../src/db/client.ts');
const workerDb = makeDb(workerPool);

const BASE = readFileSync(join(FIXTURES, 'base-180.txt'));
const FULL190 = readFileSync(join(FIXTURES, 'full-190.txt'));

let admin = '';


// process the queue until OUR job is done — parallel test files share the
// queue, so a poll may legitimately claim another file's job first
async function processUntil(importId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const processed = await runOnce(workerDb, storage, WORKER_OPTS);
    if (processed === importId) return;
    // a parallel test file may have claimed ours; done is done
    const rows = await q(`select status from app.import_jobs where id=$1`, [importId]);
    if (rows[0] && !['queued', 'processing'].includes(rows[0].status)) return;
    if (!processed) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${importId} was never claimed`);
}

async function q(sql: string, params: unknown[] = []) {
  return (await workerPool.query(sql, params)).rows;
}

async function login(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

const WORKER_OPTS = { owner: `m4-${SUFFIX}`, leaseMs: 300_000, heartbeatMs: 100_000, maxAttempts: 3, storageConcurrency: 6 };

async function uploadProcessed(name: string, bytes: Buffer, workId?: string): Promise<string> {
  const form = new FormData();
  form.append('file', new File([bytes], name));
  if (workId) form.append('workId', workId);
  const res = await app.request('/api/admin/imports', { method: 'POST', headers: { cookie: admin }, body: form });
  assert.equal(res.status, 201);
  const { importId } = await res.json() as { importId: string };
  await processUntil(importId);
  return importId;
}

async function apply(importId: string, body: object, key?: string): Promise<{ status: number; body: any }> {
  const res = await app.request(`/api/admin/imports/${importId}/apply`, {
    method: 'POST',
    headers: { cookie: admin, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createBaseWork(): Promise<string> {
  const importId = await uploadProcessed('base.txt', BASE);
  const commit = await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `m4-base-${SUFFIX}`, workType: 'serial' }),
  });
  assert.equal(commit.status, 200);
  return ((await commit.json()) as any).workId;
}

before(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
  const email = `m4-admin-${SUFFIX}@example.test`;
  await pool.query(
    `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,'admin')`,
    [`m4-admin-${SUFFIX}`, email, await hashPassword('pw-12345678')]);
  await pool.end();
  admin = await login(email, 'pw-12345678');
});

after(async () => {
  for (const w of await q(`select id from app.works where title like '%'||$1||'%'`, [`m4-${SUFFIX}`])) {
    await q(`update app.chapters set head_revision_id=null where work_id=$1`, [w.id]);
    await q(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [w.id]);
    await q(`delete from app.chapters where work_id=$1`, [w.id]);
    await q(`delete from app.works where id=$1`, [w.id]);
  }
  for (const j of await q(`select id from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%'||$1||'%')`, [SUFFIX])) {
    await q(`delete from app.apply_idempotency where import_job_id=$1`, [j.id]);
    await q(`delete from app.import_items where import_job_id=$1`, [j.id]);
    await q(`delete from app.import_jobs where id=$1`, [j.id]);
  }
  await q(`delete from app.source_files s where not exists (select 1 from app.import_jobs j where j.source_file_id = s.id) and s.created_at > now() - interval '1 hour'`);
  await q(`delete from app.sessions where user_id in (select id from app.users where email like '%'||$1||'%')`, [SUFFIX]);
  await q(`delete from app.users where email like '%'||$1||'%'`, [SUFFIX]);
  await workerPool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

test('IMP-03 + VER-01: overwrite creates new revisions on stable chapter_ids', async () => {
  const workId = await createBaseWork();
  const idsBefore = new Map((await q(
    `select id, label_raw from app.chapters where work_id=$1 and label_raw in ('第101章','第102章','第103章','第104章')`, [workId]))
    .map((r: any) => [r.label_raw, r.id]));
  const headBefore = (await q(
    `select c.label_raw, r.body_compare_hash from app.chapters c join app.chapter_revisions r on r.id=c.head_revision_id
     where c.work_id=$1 and c.label_raw='第101章'`, [workId]))[0];

  const importId = await uploadProcessed('full-190.txt', FULL190, workId);
  const { status, body } = await apply(importId, { baseEditVersion: 1, mode: 'overwrite' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.summary,
    { added: 11, updated: 4, unchanged: 176, modifiedKept: 0, skipped: 0, missingKept: 0 });

  // chapter_id unchanged (VER-01); a second immutable revision exists
  const after = await q(
    `select c.id, c.label_raw, c.head_revision_id from app.chapters c where c.work_id=$1 and c.label_raw='第101章'`, [workId]);
  assert.equal(after[0].id, idsBefore.get('第101章'));
  const revs = await q(
    `select r.id, r.body_compare_hash from app.chapter_revisions r
     where r.chapter_id=$1 order by r.created_at`, [after[0].id]);
  assert.equal(revs.length, 2, 'exactly one new revision, old one immutable');
  assert.equal(after[0].head_revision_id, revs[1].id, 'head moved to the new revision');
  assert.notEqual(revs[1].body_compare_hash, headBefore.body_compare_hash);
  assert.equal(revs[0].body_compare_hash, headBefore.body_compare_hash, 'old revision body intact');

  // same shape for the other three revised chapters
  for (const label of ['第102章', '第103章', '第104章']) {
    const r = await q(`select count(*)::int as n from app.chapter_revisions rv join app.chapters c on c.id=rv.chapter_id where c.work_id=$1 and c.label_raw=$2`, [workId, label]);
    assert.equal(r[0].n, 2, label);
  }
  // unchanged chapters did NOT get duplicate revisions
  const plain = await q(`select count(*)::int as n from app.chapter_revisions rv join app.chapters c on c.id=rv.chapter_id where c.work_id=$1 and c.label_raw='第1章'`, [workId]);
  assert.equal(plain[0].n, 1);

  // total: 191 chapters, 195 revisions (191 + 4)
  const total = await q(`select count(*)::int as n from app.chapters where work_id=$1`, [workId]);
  assert.equal(total[0].n, 191);
});

test('IMP-09: same file applied incremental first, then overwrite on a fresh upload', async () => {
  const workId = await createBaseWork();
  const inc = await uploadProcessed('full-190.txt', FULL190, workId);
  const r1 = await apply(inc, { baseEditVersion: 1, mode: 'incremental' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.summary.added, 11);
  assert.equal(r1.body.summary.modifiedKept, 4); // site versions kept

  // identical bytes re-uploaded: a NEW job with its own apply (§09)
  const over = await uploadProcessed('full-190-again.txt', FULL190, workId);
  const r2 = await apply(over, { baseEditVersion: 2, mode: 'overwrite' });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.deepEqual(r2.body.summary,
    { added: 0, updated: 4, unchanged: 187, modifiedKept: 0, skipped: 0, missingKept: 0 });

  // no duplicate chapters or revisions beyond the 4 updates
  const n = await q(`select count(*)::int as n from app.chapters where work_id=$1`, [workId]);
  assert.equal(n[0].n, 191);
  const revs = await q(`select count(*)::int as n from app.chapter_revisions r join app.chapters c on c.id=r.chapter_id where c.work_id=$1`, [workId]);
  assert.equal(revs[0].n, 195);
});

test('IMP-10 + IMP-13: Idempotency-Key — replay returns the stored result, key reuse with other payload is rejected', async () => {
  const workId = await createBaseWork();
  const importId = await uploadProcessed('full-190.txt', FULL190, workId);
  const key = `m4-${SUFFIX}-key-1`;

  const first = await apply(importId, { baseEditVersion: 1, mode: 'incremental' }, key);
  assert.equal(first.status, 200);
  const chaptersAfterFirst = (await q(`select count(*)::int as n from app.chapters where work_id=$1`, [workId]))[0].n;

  // IMP-13: response lost → client retries with the same key AND payload
  // (a different payload under the same key is the conflict case below)
  const retry = await apply(importId, { baseEditVersion: 1, mode: 'incremental' }, key);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.alreadyApplied, true);
  assert.deepEqual(retry.body.summary, first.body.summary);

  // IMP-10: same key, different payload → hard conflict, nothing done
  const conflict = await apply(importId, { baseEditVersion: 1, mode: 'overwrite' }, key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'idempotency_key_conflict');

  const chaptersAfterAll = (await q(`select count(*)::int as n from app.chapters where work_id=$1`, [workId]))[0].n;
  assert.equal(chaptersAfterAll, chaptersAfterFirst);
});

test('VER-02: revert is blocked after later edits; otherwise it restores exactly its own changes', async () => {
  const workId = await createBaseWork();

  // apply A: incremental (+11) → v2
  const a = await uploadProcessed('full-190.txt', FULL190, workId);
  const ra = await apply(a, { baseEditVersion: 1, mode: 'incremental' });
  assert.equal(ra.status, 200);
  const headBefore = (await q(
    `select c.head_revision_id from app.chapters c where c.work_id=$1 and c.label_raw='第101章'`, [workId]))[0].head_revision_id;

  // a second apply bumps the work to v3 → revert of A must now be blocked
  const b = await uploadProcessed('full-190.txt', FULL190, workId);
  const rb = await apply(b, { baseEditVersion: 2, mode: 'overwrite' });
  assert.equal(rb.status, 200);

  const planBlocked = await (await app.request(`/api/admin/imports/${a}/revert-plan`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: '{}',
  })).json();
  assert.equal(planBlocked.canRevert, false);
  assert.ok(planBlocked.reason.includes('修改'));

  const revertBlocked = await app.request(`/api/admin/imports/${a}/revert`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ baseEditVersion: 2 }),
  });
  assert.equal(revertBlocked.status, 409);
  assert.equal(((await revertBlocked.json()) as any).error, 'revert_conflict');

  // reverting B (the latest change) is allowed and restores A's state
  const planOk = await (await app.request(`/api/admin/imports/${b}/revert-plan`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: '{}',
  })).json();
  assert.equal(planOk.canRevert, true);
  assert.deepEqual(planOk.plan, { removeChapters: 0, restoreRevisions: 4, editVersionFrom: 3, editVersionTo: 2 });

  const revertB = await app.request(`/api/admin/imports/${b}/revert`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ baseEditVersion: 3 }),
  });
  assert.equal(revertB.status, 200);
  const rbBody = (await revertB.json()) as any;
  assert.equal(rbBody.removedChapters, 0);
  assert.equal(rbBody.restoredRevisions, 4);
  assert.equal(rbBody.editVersion, 2);

  // chapters 101–104 are back on their pre-overwrite revision; still 191 chapters
  const headAfter = (await q(
    `select c.head_revision_id from app.chapters c where c.work_id=$1 and c.label_raw='第101章'`, [workId]))[0].head_revision_id;
  assert.equal(headAfter, headBefore);
  const n = await q(`select count(*)::int as n from app.chapters where work_id=$1`, [workId]);
  assert.equal(n[0].n, 191);

  // now A's revert becomes possible again (work is back at its version)
  const revertA = await app.request(`/api/admin/imports/${a}/revert`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ baseEditVersion: 2 }),
  });
  assert.equal(revertA.status, 200);
  const raBody = (await revertA.json()) as any;
  assert.equal(raBody.removedChapters, 11);
  assert.equal(raBody.editVersion, 1);
  const final = await q(`select count(*)::int as n, max(editorial_position) as maxp from app.chapters where work_id=$1`, [workId]);
  assert.equal(final[0].n, 180);
  assert.equal(final[0].maxp, 180, 'positions compacted back to 1..180');

  // revert replay: same outcome, no further changes
  const replay = await app.request(`/api/admin/imports/${a}/revert`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ baseEditVersion: 1 }),
  });
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as any).alreadyReverted, true);
});
