// L2 E2E acceptance for M3 incremental apply (dev-plan §22: IMP-02, 04, 07,
// 08, 18 + §12 idempotency/version checks). Real PG, real storage, real app.
// Run: pnpm --filter server test:e2e   (needs `pnpm db:up` + `pnpm db:migrate`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-m3-'));
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
const P170 = readFileSync(join(FIXTURES, 'partial-1-170.txt'));
const P181 = readFileSync(join(FIXTURES, 'partial-181-190.txt'));

let admin = '';
let baseWorkId = ''; // the base-180 work every test re-creates

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

// upload against a target work, process, and return the import id
async function importInto(workId: string, name: string, bytes: Buffer): Promise<string> {
  const res = await app.request('/api/admin/imports', {
    method: 'POST', headers: { cookie: admin },
    body: (() => { const f = new FormData(); f.append('file', new File([bytes], name)); f.append('workId', workId); return f; })(),
  });
  assert.equal(res.status, 201, `upload ${name}`);
  const { importId } = await res.json() as { importId: string };
  const processed = await runOnce(workerDb, storage, { owner: `m3-${SUFFIX}`, leaseMs: 300_000, heartbeatMs: 100_000, maxAttempts: 3, storageConcurrency: 6 });
  assert.equal(processed, importId, 'worker claims exactly this job');
  return importId;
}

async function apply(importId: string, body: object): Promise<{ status: number; body: any }> {
  const res = await app.request(`/api/admin/imports/${importId}/apply`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getDiff(importId: string) {
  const res = await app.request(`/api/admin/imports/${importId}/diff`, { headers: { cookie: admin } });
  assert.equal(res.status, 200);
  return (await res.json()) as any;
}

// first-import commit (M2 path) of a fresh base-180 work; returns work id
async function createBaseWork(): Promise<string> {
  const res = await app.request('/api/admin/imports', {
    method: 'POST', headers: { cookie: admin },
    body: (() => { const f = new FormData(); f.append('file', new File([BASE], 'base-180.txt')); return f; })(),
  });
  const { importId } = await res.json() as { importId: string };
  await runOnce(workerDb, storage, { owner: `m3-${SUFFIX}`, leaseMs: 300_000, heartbeatMs: 100_000, maxAttempts: 3, storageConcurrency: 6 });
  const commit = await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `m3-base-${SUFFIX}`, workType: 'serial' }),
  });
  assert.equal(commit.status, 200);
  return ((await commit.json()) as any).workId;
}

before(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
  const email = `m3-admin-${SUFFIX}@example.test`;
  await pool.query(
    `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,'admin')`,
    [`m3-admin-${SUFFIX}`, email, await hashPassword('pw-12345678')]);
  await pool.end();
  admin = await login(email, 'pw-12345678');
  baseWorkId = await createBaseWork();
});

after(async () => {
  for (const w of await q(`select id from app.works where title like '%'||$1||'%'`, [`m3-${SUFFIX}`])) {
    await q(`update app.chapters set head_revision_id=null where work_id=$1`, [w.id]);
    await q(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [w.id]);
    await q(`delete from app.chapters where work_id=$1`, [w.id]);
    await q(`delete from app.works where id=$1`, [w.id]);
  }
  for (const j of await q(`select id from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%'||$1||'%')`, [SUFFIX])) {
    await q(`delete from app.import_items where import_job_id=$1`, [j.id]);
    await q(`delete from app.import_jobs where id=$1`, [j.id]);
  }
  await q(`delete from app.source_files s where not exists (select 1 from app.import_jobs j where j.source_file_id = s.id) and s.created_at > now() - interval '1 hour'`);
  await q(`delete from app.sessions where user_id in (select id from app.users where email like '%'||$1||'%')`, [SUFFIX]);
  await q(`delete from app.users where email like '%'||$1||'%'`, [SUFFIX]);
  await workerPool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

test('IMP-02 + IMP-04: full-190 incremental → +11 (incl. 87.5 mid-insert), 4 modified kept, ids stable', async () => {
  // baseline: every existing chapter id at its position
  const before = await q(`select id, label_raw, editorial_position from app.chapters where work_id=$1 order by editorial_position`, [baseWorkId]);
  assert.equal(before.length, 180);
  const idByLabel = new Map(before.map((r: any) => [r.label_raw, r.id]));
  const bodyHash87 = (await q(
    `select r.body_compare_hash from app.chapter_revisions r join app.chapters c on c.id=r.chapter_id
     where c.work_id=$1 and c.label_raw='第101章'`, [baseWorkId]))[0].body_compare_hash;

  const importId = await importInto(baseWorkId, 'full-190.txt', FULL190);
  const diff = await getDiff(importId);
  const by = (cls: string) => diff.match.items.filter((i: any) => i.itemClass === cls);
  assert.equal(by('unchanged').length, 176);
  assert.equal(by('modified').length, 4);
  assert.equal(by('new').length, 11); // 87.5 + 181..190
  const mid = diff.match.items.find((i: any) => i.labelRaw === '第87.5章');
  assert.ok(mid.positionConfident);
  assert.equal(mid.insertAfterChapterId, idByLabel.get('第87章'));
  assert.equal(mid.insertBeforeChapterId, idByLabel.get('第88章'));

  const { status, body } = await apply(importId, { baseEditVersion: 1 });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.summary, { added: 11, unchanged: 176, modifiedKept: 4, skipped: 0, missingKept: 0 });
  assert.equal(body.newEditVersion, 2);

  // 191 chapters; old chapter ids unchanged (§09 identity stability)
  const after = await q(`select id, label_raw, editorial_position from app.chapters where work_id=$1 order by editorial_position`, [baseWorkId]);
  assert.equal(after.length, 191);
  for (const r of before) {
    const now = after.find((a: any) => a.label_raw === r.label_raw && a.id === r.id);
    assert.ok(now, `chapter ${r.label_raw} kept its id`);
  }
  // 87.5 sits between 87 and 88
  const pos = new Map(after.map((r: any) => [r.label_raw, r.editorial_position]));
  assert.equal(pos.get('第87章'), 87);
  assert.equal(pos.get('第87.5章'), 88);
  assert.equal(pos.get('第88章'), 89);
  assert.equal(pos.get('第190章'), 191);

  // modified chapters keep the site version (§05): 第101章 body hash unchanged
  const bodyHash101 = (await q(
    `select r.body_compare_hash from app.chapter_revisions r join app.chapters c on c.id=r.chapter_id
     where c.work_id=$1 and c.label_raw='第101章'`, [baseWorkId]))[0].body_compare_hash;
  assert.equal(bodyHash101, bodyHash87);
});

test('apply is idempotent: retry returns the same result, creates nothing', async () => {
  const importId = await importInto(baseWorkId, 'p181.txt', P181);
  const first = await apply(importId, { baseEditVersion: 2, confirmAppend: true });
  assert.equal(first.status, 200);
  const countBefore = (await q(`select count(*)::int as n from app.chapters where work_id=$1`, [baseWorkId]))[0].n;
  const retry = await apply(importId, { baseEditVersion: 99, confirmAppend: true }); // stale version must not matter on replay
  assert.equal(retry.status, 200);
  assert.equal(retry.body.alreadyApplied, true);
  assert.deepEqual(retry.body.summary, first.body.summary);
  const countAfter = (await q(`select count(*)::int as n from app.chapters where work_id=$1`, [baseWorkId]))[0].n;
  assert.equal(countAfter, countBefore);
});

test('edit_version conflict: stale base is rejected, nothing applied', async () => {
  const importId = await importInto(baseWorkId, 'p170.txt', P170);
  const r = await apply(importId, { baseEditVersion: 1 }); // stale: work is at 3 now
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'edit_version_conflict');
});

test('IMP-08: 1–170 upload → nothing added, 171–180 kept', async () => {
  const cur = (await q(`select edit_version from app.works where id=$1`, [baseWorkId]))[0].edit_version;
  const importId = await importInto(baseWorkId, 'p170.txt', P170);
  const diff = await getDiff(importId);
  assert.equal(diff.match.items.filter((i: any) => i.itemClass === 'unchanged').length, 170);
  assert.equal(diff.match.missingFromSource.length, 21); // 87.5, 181–190 were added earlier
  const r = await apply(importId, { baseEditVersion: cur });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.summary, { added: 0, unchanged: 170, modifiedKept: 0, skipped: 0, missingKept: 21 });
  const n = (await q(`select count(*)::int as n from app.chapters where work_id=$1`, [baseWorkId]))[0].n;
  assert.equal(n, 191); // unchanged total
});

test('IMP-07: standalone 181–190 (on a fresh work) needs confirmAppend, then appends', async () => {
  const workId = await createBaseWork();
  const importId = await importInto(workId, 'tail.txt', P181);
  const diff = await getDiff(importId);
  assert.ok(diff.match.items.every((i: any) => i.itemClass === 'new' && !i.positionConfident));

  const refused = await apply(importId, { baseEditVersion: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'resolution_required');
  assert.equal(refused.body.unresolved.length, 10);

  const ok = await apply(importId, { baseEditVersion: 1, confirmAppend: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.summary.added, 10);
  const tail = await q(`select label_raw, editorial_position from app.chapters where work_id=$1 order by editorial_position desc limit 3`, [workId]);
  assert.deepEqual(tail.map((r: any) => r.label_raw), ['第190章', '第189章', '第188章']);
  assert.equal(tail[0].editorial_position, 190);
});

test('IMP-18: renumbered source is blocked with an unresolved list; Admin can resolve', async () => {
  const tiny = '第1章 一\n\n他推開了那扇門，走了進去。\n\n第2章 二\n\n雨下了一整夜，沒有停過。\n\n第3章 三\n\n他們在橋上分別，各自回家。\n\n第4章 四\n\n燈亮起來的時候，他已經睡了。\n\n第5章 五\n\n最後一班車開走了，月台空了。\n';
  const res = await app.request('/api/admin/imports', {
    method: 'POST', headers: { cookie: admin },
    body: (() => { const f = new FormData(); f.append('file', new File([Buffer.from(tiny)], 't.txt')); return f; })(),
  });
  const { importId: firstId } = await res.json() as { importId: string };
  await runOnce(workerDb, storage, { owner: `m3-${SUFFIX}`, leaseMs: 300_000, heartbeatMs: 100_000, maxAttempts: 3, storageConcurrency: 6 });
  const commit = await app.request(`/api/admin/imports/${firstId}/commit`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `m3-tiny-${SUFFIX}`, workType: 'serial' }),
  });
  const tinyWorkId = ((await commit.json()) as any).workId;

  // renumbered source: same bodies, labels shifted by one
  const shifted = '第2章 一\n\n他推開了那扇門，走了進去。\n\n第3章 二\n\n雨下了一整夜，沒有停過。\n\n第4章 三\n\n他們在橋上分別，各自回家。\n\n第5章 四\n\n燈亮起來的時候，他已經睡了。\n\n第6章 五\n\n最後一班車開走了，月台空了。\n';
  const importId = await importInto(tinyWorkId, 'shift.txt', Buffer.from(shifted));
  const refused = await apply(importId, { baseEditVersion: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'resolution_required');
  assert.ok(refused.body.unresolved.length >= 4);
  assert.ok(refused.body.unresolved.some((u: any) => u.reason.includes('body_belongs_to_other_chapter')));

  // Admin excludes the shifted items rather than guessing (§10)
  const resolutions = Object.fromEntries(refused.body.unresolved.map((u: any) => [u.itemId, 'exclude']));
  const ok = await apply(importId, { baseEditVersion: 1, resolutions });
  assert.equal(ok.status, 200);
  // the four shifted items are excluded; 第6章 is a confidently-anchored new
  // chapter (genuinely new content at the tail) and is added
  assert.equal(ok.body.summary.added, 1);
  assert.equal(ok.body.summary.skipped, refused.body.unresolved.length);
  assert.equal(ok.body.summary.modifiedKept + ok.body.summary.unchanged, 0);
  const n = (await q(`select count(*)::int as n from app.chapters where work_id=$1`, [tinyWorkId]))[0].n;
  assert.equal(n, 6); // nothing silently overwritten or duplicated
  // the four original chapters still carry their original bodies
  const bodies = await q(
    `select c.label_raw, r.body_compare_hash from app.chapters c join app.chapter_revisions r on r.id=c.head_revision_id
     where c.work_id=$1 and c.label_raw in ('第1章','第2章','第3章','第4章','第5章') order by c.editorial_position`, [tinyWorkId]);
  assert.equal(bodies.length, 5);
  const distinct = new Set(bodies.map((b: any) => b.body_compare_hash));
  assert.equal(distinct.size, 5); // every original body still distinct/intact
});
