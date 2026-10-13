// Integration: library organization, filtered rankings, and taxonomy recommendations.
// pnpm --filter server exec node --env-file-if-exists=.env --test test/e2e-discovery-features.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-discovery-'));
const { app, apiPool } = await import('../src/index.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const suffix = crypto.randomUUID().slice(0, 8);
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const ids: Record<string, string> = {};
const users: string[] = [];
const categories: string[] = [];
const tags: string[] = [];
let cookieA = ''; let cookieB = '';
async function request(path: string, cookie = '', method = 'GET', body?: unknown) {
  return app.request(path, { method, headers: { cookie, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function json(path: string, cookie = '') {
  const response = await request(path, cookie);
  assert.equal(response.status, 200, path);
  return response.json();
}
async function seed(name: string, categoryIndexes: number[], tagIndexes: number[], options: { visibility?: string; published?: boolean; status?: string } = {}) {
  const [work] = await q(`insert into app.works (title, work_type, serial_status, visibility)
    values ($1,'serial',$2,$3) returning id`, [`Discovery-${suffix}-${name}`, options.status ?? 'ongoing', options.visibility ?? 'public']);
  ids[name] = work.id;
  if (options.published !== false) {
    const [release] = await q(`insert into app.work_releases (work_id,version,chapter_count,created_by_user_id)
      values ($1,1,0,$2) returning id`, [work.id, users[0]]);
    await q(`update app.works set active_release_id=$1 where id=$2`, [release.id, work.id]);
  }
  for (const index of categoryIndexes) await q(`insert into app.work_categories (work_id,category_id) values ($1,$2)`, [work.id, categories[index]]);
  for (const index of tagIndexes) await q(`insert into app.work_tags (work_id,tag_id) values ($1,$2)`, [work.id, tags[index]]);
}
before(async () => {
  const passwordHash = await hashPassword('test-password-123');
  for (const name of ['a', 'b']) {
    const email = `discovery-${suffix}-${name}@example.test`;
    const [user] = await q(`insert into app.users (username,email,password_hash,role) values ($1,$2,$3,'member') returning id`, [`discovery-${suffix}-${name}`, email, passwordHash]);
    users.push(user.id);
    const response = await request('/api/auth/login', '', 'POST', { email, password: 'test-password-123' });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ');
    if (name === 'a') cookieA = cookie; else cookieB = cookie;
  }
  for (let index = 0; index < 2; index++) categories.push((await q(`insert into app.categories (display_name) values ($1) returning id`, [`Discovery-${suffix}-cat${index}`]))[0].id);
  for (let index = 0; index < 3; index++) tags.push((await q(`insert into app.tags (display_name,is_active) values ($1,$2) returning id`, [`Discovery-${suffix}-tag${index}`, index !== 2]))[0].id);
  await seed('source', [0, 1], [0, 1, 2]);
  await seed('tagsFirst', [], [0, 1], { status: 'completed' });
  await seed('both', [0], [0]);
  await seed('tagOnly', [], [0]);
  await seed('categoryOnly', [0, 1], []);
  await seed('inactiveOnly', [], [2]);
  await seed('draft', [0, 1], [0, 1], { visibility: 'draft' });
  await seed('unlisted', [0, 1], [0, 1], { visibility: 'unlisted' });
  await seed('unpublished', [0, 1], [0, 1], { published: false });
  for (const name of ['source', 'both', 'categoryOnly']) assert.equal((await request(`/api/me/library/${ids[name]}`, cookieA, 'PUT')).status, 200);
  await q(`insert into app.work_clicks (work_id,visitor_hash,day) values ($1,$2,(now() at time zone 'Asia/Taipei')::date - 400)`, [ids.both, `old-${suffix}`]);
  await q(`insert into app.work_clicks (work_id,visitor_hash,day) values ($1,$2,(now() at time zone 'Asia/Taipei')::date)`, [ids.categoryOnly, `recent-${suffix}`]);
  await q(`insert into app.work_categories (work_id,category_id) values ($1,$2)`, [ids.tagsFirst, categories[0]]);
  await q(`insert into app.work_clicks (work_id,visitor_hash,day) values ($1,$2,(now() at time zone 'Asia/Taipei')::date)`, [ids.tagsFirst, `completed-${suffix}`]);
});
after(async () => {
  for (const workId of Object.values(ids)) {
    await q(`delete from app.user_library where work_id=$1`, [workId]);
    await q(`delete from app.work_categories where work_id=$1`, [workId]);
    await q(`delete from app.work_tags where work_id=$1`, [workId]);
    await q(`update app.works set active_release_id=null where id=$1`, [workId]);
    await q(`delete from app.work_releases where work_id=$1`, [workId]);
    await q(`delete from app.works where id=$1`, [workId]);
  }
  for (const id of categories) await q(`delete from app.categories where id=$1`, [id]);
  for (const id of tags) await q(`delete from app.tags where id=$1`, [id]);
  for (const id of users) {
    await q(`delete from app.sessions where user_id=$1`, [id]);
    await q(`delete from app.users where id=$1`, [id]);
  }
  await pool.end();
  await apiPool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

test('library metadata remains private; duplicate saves retain group, status, and favorite age', async () => {
  const before = (await q(`select created_at from app.user_library where user_id=$1 and work_id=$2`, [users[0], ids.source]))[0].created_at;
  assert.equal((await request(`/api/me/library/${ids.source}`, cookieA, 'PATCH', { groupName: '  科幻  ', readingStatus: 'finished' })).status, 200);
  assert.equal((await request(`/api/me/library/${ids.source}`, cookieB, 'PATCH', { groupName: 'other' })).status, 404);
  assert.equal((await request(`/api/me/library/${ids.source}`, cookieA, 'PUT')).status, 200);
  const [row] = await q(`select group_name,reading_status,created_at from app.user_library where user_id=$1 and work_id=$2`, [users[0], ids.source]);
  assert.equal(row.group_name, '科幻'); assert.equal(row.reading_status, 'finished'); assert.deepEqual(row.created_at, before);
  const own = await json('/api/me/library?groupName=科幻&readingStatus=finished', cookieA);
  assert.deepEqual(own.works.map((work: { workId: string }) => work.workId), [ids.source]);
  assert.deepEqual((await json('/api/me/library', cookieB)).groups, []);
  assert.equal((await request(`/api/me/library/${ids.source}`, cookieA, 'PATCH', { readingStatus: 'invalid' })).status, 400);
});

test('library group/status filtering paginates without omissions and binds cursor to owner and filters', async () => {
  for (const name of ['both', 'categoryOnly']) assert.equal((await request(`/api/me/library/${ids[name]}`, cookieA, 'PATCH', { groupName: '科幻', readingStatus: 'reading' })).status, 200);
  const first = await json('/api/me/library?limit=1&groupName=科幻&readingStatus=reading', cookieA);
  assert.equal(first.works.length, 1); assert.ok(first.nextCursor); assert.deepEqual(first.groups, ['科幻']);
  const next = await json(`/api/me/library?limit=1&groupName=科幻&readingStatus=reading&cursor=${encodeURIComponent(first.nextCursor)}`, cookieA);
  assert.equal(next.works.length, 1); assert.equal(next.nextCursor, null);
  assert.deepEqual(new Set([first.works[0].workId, next.works[0].workId]), new Set([ids.both, ids.categoryOnly]));
  assert.equal((await request(`/api/me/library?groupName=科幻&readingStatus=finished&cursor=${encodeURIComponent(first.nextCursor)}`, cookieA)).status, 400);
  assert.equal((await request(`/api/me/library?groupName=科幻&readingStatus=reading&cursor=${encodeURIComponent(first.nextCursor)}`, cookieB)).status, 400);
  assert.equal((await request(`/api/me/library/${ids.both}`, cookieA, 'PATCH', { groupName: null })).status, 200);
  const ungrouped = await json('/api/me/library?groupName=', cookieA);
  assert.deepEqual(ungrouped.works.map((work: { workId: string }) => work.workId), [ids.both]);
});

test('rankings combine status/category filters and retain old clicks only in totals', async () => {
  const base = `/api/rankings?type=clicks&categoryId=${categories[0]}`;
  const all = await json(`${base}&period=all`);
  const year = await json(`${base}&period=year`);
  assert.ok(all.works.some((work: { id: string }) => work.id === ids.both));
  assert.ok(!year.works.some((work: { id: string }) => work.id === ids.both));
  for (const period of ['week', 'month', 'year', 'all']) {
    const completed = await json(`${base}&period=${period}&serialStatus=completed`);
    assert.deepEqual(completed.works.map((work: { id: string }) => work.id), [ids.tagsFirst]);
  }
  const favorites = await json(`/api/rankings?type=favorites&period=all&categoryId=${categories[0]}&serialStatus=ongoing`);
  assert.deepEqual(new Set(favorites.works.map((work: { id: string }) => work.id)), new Set([ids.source, ids.both, ids.categoryOnly]));
  assert.equal((await request(`${base}&serialStatus=unknown`)).status, 400);
  assert.equal((await request('/api/rankings?categoryId=invalid')).status, 400);
});

test('related works use active tags then categories and exclude inaccessible or unpublished candidates', async () => {
  const related = await json(`/api/works/${ids.source}/related`);
  assert.deepEqual(related.works.map((work: { id: string }) => work.id), [ids.tagsFirst, ids.both, ids.tagOnly, ids.categoryOnly]);
  assert.equal(related.works[0].sharedTags, 2);
  assert.equal(related.works[1].sharedCategories, 1);
  assert.equal((await request(`/api/works/${ids.draft}/related`)).status, 404);
  assert.equal((await request(`/api/works/${ids.unpublished}/related`)).status, 404);
  assert.equal((await request(`/api/works/${ids.unlisted}/related`)).status, 200);
});
