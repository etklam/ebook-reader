import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-reports-'));
const { app, apiPool: appApiPool } = await import('../src/index.ts');
const { localStorage } = await import('../src/storage.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const storage = localStorage(process.env.STORAGE_ROOT);
const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 1 });
const apiPool = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
const suffix = Math.random().toString(36).slice(2, 10);
let workId = '';
let chapterId = '';
let revisionId = '';
let staleRevisionId = '';
let adminId = '';
let admin = '';
let member = '';

async function login(role: string) {
  const response = await app.request('/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `e2e-reports-${role}-${suffix}@example.test`, password: 'pw-12345678' }) });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}

before(async () => {
  for (const role of ['admin', 'member']) {
    const result = await apiPool.query(`insert into app.users (username,email,password_hash,role)
      values ($1,$2,$3,$4) returning id`, [`reports-${role}-${suffix}`,
      `e2e-reports-${role}-${suffix}@example.test`, await hashPassword('pw-12345678'), role]);
    if (role === 'admin') adminId = result.rows[0].id;
  }
  admin = await login('admin'); member = await login('member');
  const contentKey = await storage.put(Buffer.from('第一段原文\n\n第二段錯字'), 'txt');
  const client = await workerPool.connect();
  try {
    await client.query('begin');
    workId = (await client.query(`insert into app.works (title,work_type,visibility)
      values ($1,'short_story','public') returning id`, [`回報測試-${suffix}`])).rows[0].id;
    chapterId = (await client.query(`insert into app.chapters (work_id,label_raw,editorial_position)
      values ($1,'第一章',1) returning id`, [workId])).rows[0].id;
    for (const version of ['stale', 'published']) {
      const revision = (await client.query(`insert into app.chapter_revisions
        (chapter_id,title,content_key,body_compare_hash,revision_hash,processor_version)
        values ($1,$2,$3,$4,$4,'test') returning id`, [chapterId, version, contentKey, version])).rows[0].id;
      if (version === 'stale') staleRevisionId = revision;
      else revisionId = revision;
    }
    await client.query('update app.chapters set head_revision_id=$1 where id=$2', [revisionId, chapterId]);
    const releaseId = (await client.query(`insert into app.work_releases
      (work_id,version,chapter_count,created_by_user_id) values ($1,1,1,$2) returning id`, [workId, adminId])).rows[0].id;
    await client.query(`insert into app.release_items (release_id,chapter_id,revision_id,editorial_position,label_raw,title)
      values ($1,$2,$3,1,'第一章','已公開章節')`, [releaseId, chapterId, revisionId]);
    await client.query('update app.works set active_release_id=$1 where id=$2', [releaseId, workId]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
});

after(async () => {
  if (workId) {
    await workerPool.query('delete from app.content_reports where work_id=$1', [workId]);
    await workerPool.query('update app.works set active_release_id=null where id=$1', [workId]);
    await workerPool.query('delete from app.release_items where release_id in (select id from app.work_releases where work_id=$1)', [workId]);
    await workerPool.query('delete from app.work_releases where work_id=$1', [workId]);
    await workerPool.query('update app.chapters set head_revision_id=null where work_id=$1', [workId]);
    await workerPool.query('delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)', [workId]);
    await workerPool.query('delete from app.chapters where work_id=$1', [workId]);
    await workerPool.query('delete from app.works where id=$1', [workId]);
  }
  await apiPool.query('delete from app.sessions where user_id in (select id from app.users where email like $1)', [`e2e-reports-%-${suffix}@example.test`]);
  await apiPool.query('delete from app.users where email like $1', [`e2e-reports-%-${suffix}@example.test`]);
  await Promise.all([workerPool.end(), apiPool.end(), appApiPool.end()]);
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

test('REPORT-E2E: active revision validation, immutable excerpt, member/admin authorization and resolution', async () => {
  const submit = (cookie: string, patch: Record<string, unknown> = {}) => app.request('/api/me/content-reports', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ workId, chapterId, revisionId, paragraphIndex: 1, message: '應為正字', ...patch }),
  });
  assert.equal((await submit('')).status, 401);
  assert.equal((await submit(member, { revisionId: staleRevisionId })).status, 404);
  const reachable = await apiPool.query(`select cr.id from app.works w
    join app.release_items ri on ri.release_id=w.active_release_id
    join app.chapters ch on ch.id=ri.chapter_id and ch.work_id=w.id
    join app.chapter_revisions cr on cr.id=ri.revision_id and cr.chapter_id=ch.id
    where w.id=$1 and ch.id=$2 and cr.id=$3`, [workId,chapterId,revisionId]);
  assert.equal(reachable.rows.length, 1, 'published report target must be reachable by API role');
  assert.equal((await submit(member, { paragraphIndex: 2 })).status, 400);
  assert.equal((await submit(member, { message: 'x'.repeat(1001) })).status, 400);
  const response = await submit(member, { excerpt: '偽造摘錄', message: 'x'.repeat(1000) });
  assert.equal(response.status, 201, await response.clone().text());
  const { id } = await response.json() as { id: string };
  const stored = (await workerPool.query('select excerpt,message,revision_id,status from app.content_reports where id=$1', [id])).rows[0];
  assert.equal(stored.excerpt, '第二段錯字');
  assert.equal(stored.message.length, 1000);
  assert.equal(stored.revision_id, revisionId);
  assert.equal(stored.status, 'open');
  assert.equal((await app.request('/api/admin/content-reports', { headers: { cookie: member } })).status, 403);
  const list = await (await app.request('/api/admin/content-reports?status=open', { headers: { cookie: admin } })).json() as { reports: Array<{ id: string; workId: string }> };
  assert.ok(list.reports.some((report) => report.id === id && report.workId === workId));
  const resolve = (cookie: string) => app.request(`/api/admin/content-reports/${id}`, { method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) });
  assert.equal((await resolve(member)).status, 403);
  assert.equal((await resolve(admin)).status, 200);
  const resolved = (await workerPool.query('select status,resolved_at from app.content_reports where id=$1', [id])).rows[0];
  assert.equal(resolved.status, 'resolved'); assert.ok(resolved.resolved_at);
  await workerPool.query("update app.works set visibility='removed' where id=$1", [workId]);
  assert.equal((await submit(member)).status, 404);
});
