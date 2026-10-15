// ER-010 review endpoints: real database and storage; this never publishes.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-review-'));
const { app } = await import('../src/index.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const { localStorage } = await import('../src/storage.ts');
const storage = localStorage(process.env.STORAGE_ROOT);
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
const suffix = randomUUID().slice(0, 8);
let userId = ''; let cookie = '';
const workIds: string[] = []; const jobs: string[] = []; const sourceIds: string[] = []; const resourceIds: string[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
async function call(path: string, body?: unknown, key?: string) {
  const response = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
async function fixture(source: Array<{ label: string; body: string }>, site = [{ label: '第1章', body: '站方一' }, { label: '第3章', body: '站方三' }]) {
  const workId = (await q(`insert into app.works(title,work_type) values($1,'serial') returning id`, [`review-${suffix}`]))[0].id; workIds.push(workId);
  const chapterIds: string[] = [];
  for (const [index, chapter] of site.entries()) {
    const chapterId = (await q(`insert into app.chapters(work_id,label_raw,editorial_position) values($1,$2,$3) returning id`, [workId, chapter.label, index + 1]))[0].id; chapterIds.push(chapterId);
    const key = await storage.put(Buffer.from(chapter.body), 'txt');
    const revisionId = (await q(`insert into app.chapter_revisions(chapter_id,title,content_key,body_compare_hash,revision_hash,processor_version) values($1,'',$2,$3,$3,'review-test') returning id`, [chapterId, key, hash(chapter.body)]))[0].id;
    await q(`update app.chapters set head_revision_id=$2 where id=$1`, [chapterId, revisionId]);
  }
  const fileKey = await storage.put(Buffer.from('source'), 'txt');
  const sourceId = (await q(`insert into app.source_files(work_id,storage_key,file_hash,size_bytes,mime_type) values($1,$2,$3,6,'text/plain') returning id`, [workId, fileKey, hash(randomUUID())]))[0].id; sourceIds.push(sourceId);
  const jobId = (await q(`insert into app.import_jobs(work_id,source_file_id,requested_by_user_id,status,processor_version,attempt_count,completed_at) values($1,$2,$3,'ready','review-test',1,now()) returning id`, [workId, sourceId, userId]))[0].id; jobs.push(jobId);
  const itemIds: string[] = [];
  for (const [position, chapter] of source.entries()) {
    const key = await storage.put(Buffer.from(chapter.body), 'txt');
    itemIds.push((await q(`insert into app.import_items(import_job_id,position,label_raw,title,content_key,body_hash) values($1,$2,$3,'',$4,$5) returning id`, [jobId, position, chapter.label, key, hash(chapter.body)]))[0].id);
  }
  return { workId, jobId, itemIds, chapterIds, path: `/api/admin/imports/${jobId}` };
}
before(async () => {
  const email = `review-${suffix}@example.test`;
  userId = (await ownerPool.query(`insert into app.users(username,email,password_hash,role) values($1,$2,$3,'admin') returning id`, [`review-${suffix}`, email, await hashPassword('review-password')])).rows[0].id;
  const response = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'review-password' }) });
  assert.equal(response.status, 200); cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
});
after(async () => {
  for (const workId of workIds) {
    await q(`update app.chapters set head_revision_id=null where work_id=$1`, [workId]);
    await q(`delete from app.chapter_revision_resources where revision_id in(select r.id from app.chapter_revisions r join app.chapters c on c.id=r.chapter_id where c.work_id=$1)`, [workId]);
    await q(`delete from app.chapter_revisions where chapter_id in(select id from app.chapters where work_id=$1)`, [workId]);
    await q(`delete from app.chapters where work_id=$1`, [workId]);
  }
  for (const jobId of jobs) { await q(`delete from app.import_item_resources where import_item_id in(select id from app.import_items where import_job_id=$1)`, [jobId]); await q(`delete from app.apply_idempotency where import_job_id=$1`, [jobId]); await q(`delete from app.import_items where import_job_id=$1`, [jobId]); await q(`delete from app.import_jobs where id=$1`, [jobId]); }
  for (const resourceId of resourceIds) await q(`delete from app.resources where id=$1`, [resourceId]);
  for (const sourceId of sourceIds) await q(`delete from app.source_files where id=$1`, [sourceId]);
  for (const workId of workIds) await q(`delete from app.works where id=$1`, [workId]);
  if (userId) { await q(`delete from app.sessions where user_id=$1`, [userId]); await q(`delete from app.users where id=$1`, [userId]); }
  await pool.end(); await ownerPool.end(); rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

test('review metadata is bounded; details/admin authorization and missing-source preservation', async () => {
  const f = await fixture(Array.from({ length: 44 }, (_, index) => ({ label: `第${index + 50}章`, body: '來源正文'.repeat(10000) })));
  const review = await call(`${f.path}/review`); assert.equal(review.status, 200); assert.equal(review.body.rows.length, 40); assert.equal(review.body.counts.missing, 2); assert.equal(JSON.stringify(review.body).includes('來源正文'), false);
  const denied = await app.request(`${f.path}/review`); assert.ok([401, 403].includes(denied.status));
  const params = new URLSearchParams({ analysisVersion: review.body.analysisVersion, editVersion: String(review.body.editVersion), itemId: f.itemIds[0], chapterId: f.chapterIds[0] });
  const detail = await call(`${f.path}/review/detail?${params}`); assert.equal(detail.status, 200); assert.equal(detail.body.source.text.length, 24000); assert.equal(detail.body.source.hasMore, true); assert.equal(detail.body.site.text, '站方一');
  params.set('offset', '24000'); assert.equal((await call(`${f.path}/review/detail?${params}`)).body.offset, 24000);
  const another = await fixture([]); params.set('chapterId', another.chapterIds[0]); assert.equal((await call(`${f.path}/review/detail?${params}`)).status, 404);
});

test('preview validates unresolved conflicts; manual mapping/exclusion, exact plan, insertion, retry and version guards', async () => {
  const f = await fixture([{ label: '第1章', body: '站方一' }, { label: '第2章', body: '插入二' }, { label: '第3章', body: '修訂三' }]);
  const review = (await call(`${f.path}/review`)).body;
  const payload = { baseEditVersion: review.editVersion, analysisVersion: review.analysisVersion, mode: 'overwrite' };
  const preview = await call(`${f.path}/review-plan`, payload); assert.equal(preview.status, 200); assert.equal(preview.body.summary.added, 1); assert.equal(preview.body.summary.updated, 1);
  assert.equal((await q(`select edit_version from app.works where id=$1`, [f.workId]))[0].edit_version, review.editVersion);
  const key = randomUUID(); const first = await call(`${f.path}/apply`, payload, key); assert.equal(first.status, 200);
  const retry = await call(`${f.path}/apply`, payload, key); assert.equal(retry.body.alreadyApplied, true);
  assert.deepEqual((await q(`select label_raw from app.chapters where work_id=$1 order by editorial_position`, [f.workId])).map((row) => row.label_raw), ['第1章', '第2章', '第3章']);
  assert.equal((await q(`select active_release_id from app.works where id=$1`, [f.workId]))[0].active_release_id, null);
  const conflict = await fixture([{ label: '第1章', body: '站方三' }, { label: '第3章', body: '站方三' }]);
  const cReview = (await call(`${conflict.path}/review`)).body;
  const cPayload = { baseEditVersion: cReview.editVersion, analysisVersion: cReview.analysisVersion, mode: 'overwrite', resolutions: {} as Record<string, string> };
  assert.equal((await call(`${conflict.path}/review-plan`, cPayload)).body.error, 'resolution_required');
  cPayload.resolutions[conflict.itemIds[0]] = 'exclude'; assert.equal((await call(`${conflict.path}/review-plan`, cPayload)).body.summary.skipped, 1);
  cPayload.resolutions[conflict.itemIds[0]] = `match:${conflict.chapterIds[0]}`; assert.equal((await call(`${conflict.path}/review-plan`, cPayload)).body.summary.updated, 1);
  await q(`update app.import_jobs set attempt_count=2 where id=$1`, [conflict.jobId]);
  assert.equal((await call(`${conflict.path}/apply`, cPayload)).body.error, 'analysis_version_conflict');
  const fresh = (await call(`${conflict.path}/review`)).body; cPayload.analysisVersion = fresh.analysisVersion;
  await q(`update app.works set edit_version=edit_version+1 where id=$1`, [conflict.workId]);
  assert.equal((await call(`${conflict.path}/apply`, cPayload)).body.error, 'edit_version_conflict');
});

test('ambiguous labels and no anchors require explicit supported choices; before-first insertion follows anchor', async () => {
  const f = await fixture([{ label: '第9章', body: '九甲' }, { label: '第9章', body: '九乙' }]);
  const review = (await call(`${f.path}/review?filter=pending`)).body; assert.equal(review.pendingCount, 2);
  const payload = { baseEditVersion: review.editVersion, analysisVersion: review.analysisVersion, resolutions: { [f.itemIds[0]]: 'new', [f.itemIds[1]]: 'exclude' } };
  const plan = await call(`${f.path}/review-plan`, payload); assert.equal(plan.status, 200); assert.equal(plan.body.summary.added, 1); assert.equal(plan.body.summary.missingKept, 2);
  const head = await fixture([{ label: '第0章', body: '序章' }, { label: '第1章', body: '站方一' }, { label: '第3章', body: '站方三' }]);
  const h = (await call(`${head.path}/review`)).body;
  assert.equal((await call(`${head.path}/apply`, { baseEditVersion: h.editVersion, analysisVersion: h.analysisVersion })).status, 200);
  assert.equal((await q(`select label_raw from app.chapters where work_id=$1 order by editorial_position limit 1`, [head.workId]))[0].label_raw, '第0章');
});


test('manual mappings reject duplicate targets and compare resource metadata as automatic matching does', async () => {
  const duplicate = await fixture([{ label: '第9章', body: '新九' }, { label: '第10章', body: '新十' }]);
  const d = (await call(`${duplicate.path}/review`)).body;
  const payload = { baseEditVersion: d.editVersion, analysisVersion: d.analysisVersion, resolutions: Object.fromEntries(duplicate.itemIds.map((id) => [id, `match:${duplicate.chapterIds[0]}`])) };
  for (const endpoint of ['review-plan', 'apply']) assert.equal((await call(`${duplicate.path}/${endpoint}`, payload)).body.error, 'duplicate_resolution_target');
  const auto = await fixture([{ label: '第1章', body: '站方一' }, { label: '第9章', body: '新九' }]);
  const a = (await call(`${auto.path}/review`)).body;
  assert.equal((await call(`${auto.path}/review-plan`, { baseEditVersion: a.editVersion, analysisVersion: a.analysisVersion, resolutions: { [auto.itemIds[1]]: `match:${auto.chapterIds[0]}` } })).body.error, 'duplicate_resolution_target');

  const resource = await fixture([{ label: '第9章', body: '站方一' }]);
  const key = await storage.put(Buffer.from('image-bytes'), 'png'); const contentHash = hash(randomUUID());
  const resourceId = (await q(`insert into app.resources(content_hash,storage_key,media_type,size_bytes) values($1,$2,'image/png',11) returning id`, [contentHash, key]))[0].id; resourceIds.push(resourceId);
  const revisionId = (await q(`select head_revision_id from app.chapters where id=$1`, [resource.chapterIds[0]]))[0].head_revision_id;
  await q(`insert into app.chapter_revision_resources(revision_id,resource_id,content_hash,alt) values($1,$2,$3,'舊說明')`, [revisionId, resourceId, contentHash]);
  await q(`insert into app.import_item_resources(import_item_id,resource_id,content_hash,alt) values($1,$2,$3,'新說明')`, [resource.itemIds[0], resourceId, contentHash]);
  const r = (await call(`${resource.path}/review`)).body;
  const rPayload = { baseEditVersion: r.editVersion, analysisVersion: r.analysisVersion, mode: 'overwrite', resolutions: { [resource.itemIds[0]]: `match:${resource.chapterIds[0]}` } };
  const plan = await call(`${resource.path}/review-plan`, rPayload); assert.equal(plan.body.summary.updated, 1); assert.equal(plan.body.summary.unchanged, 0);
  assert.equal((await call(`${resource.path}/apply`, rPayload)).status, 200);
  const links = await q(`select rr.alt from app.chapter_revision_resources rr join app.chapters c on c.head_revision_id=rr.revision_id where c.id=$1`, [resource.chapterIds[0]]);
  assert.deepEqual(links.map((link) => link.alt), ['新說明']);
});
