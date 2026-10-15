// ER-001/004 bounded TOC metadata; ER-003 private notes and all-owner paging.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { makeDb } from '../src/db/client.ts';
import { readerRoutes } from '../src/routes/reader.ts';
import { meRoutes } from '../src/routes/me.ts';
import type { Storage } from '../src/storage.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const db = makeDb(pool);
const user = randomUUID(), other = randomUUID(), work = randomUUID(), olderWork = randomUUID(), release = randomUUID();
let current: string, first: string, last: string, olderChapter: string, olderRevision: string;
const app = new Hono<{ Variables: { userId: string; role: string } }>();
// Test-local identity injection; the existing full-stack suite tests sessions.
app.use('*', async (c, next) => { c.set('userId', c.req.header('test-user') ?? ''); c.set('role', c.req.header('test-role') ?? 'member'); await next(); });
const noStorage = new Proxy({}, { get() { throw new Error('TOC must never access body storage'); } }) as Storage;
app.route('/', readerRoutes({ db, storage: noStorage }));
app.route('/', meRoutes({ db }));
const toc = (query = '') => app.request(`/api/reader/works/${work}/chapters?${query}`);
const mine = (query = '') => app.request(`/api/me/bookmarks?${query}`, { headers: { 'test-user': user } });
const write = (path: string, method: string, body?: unknown, identity = user) => app.request(path, {
  method, headers: { 'test-user': identity, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
type Page = { total: number; offset: number; version: string; anchorMissing: boolean; nextOffset: number | null;
  chapters: Array<{ id: string; revisionId: string; editorialPosition: number; labelRaw: string; title: string }> };
async function page(query = ''): Promise<Page> {
  const response = await toc(query);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
before(async () => {
  await pool.query(`insert into app.users (id,username,email,password_hash) values ($1,'toc-bookmarks',$3,'unused'),($2,'other-member',$4,'unused')`, [user, other, `${user}@test.invalid`, `${other}@test.invalid`]);
  await pool.query(`insert into app.works (id,title,work_type,visibility) values ($1,'TOC 5000','serial','public'),($2,'Older bookmark work','serial','public')`, [work, olderWork]);
  await pool.query(`insert into app.chapters (work_id,label_raw,editorial_position) select $1,
    case n when 847 then '第12章（上）' when 848 then '第12章（下）' when 849 then '12.10' else '第' || n || '章' end,
    n * 3 from generate_series(1,5000) n`, [work]);
  await pool.query(`insert into app.chapters (work_id,label_raw,editorial_position) values ($1,'序',3)`, [olderWork]);
  await pool.query(`insert into app.chapter_revisions (chapter_id,title,content_key,body_compare_hash,revision_hash,processor_version)
    select id,case when editorial_position in (2541,2544) then '故事龍門' else '故事' end,'never-read',id::text,id::text,'test'
    from app.chapters where work_id in ($1,$2)`, [work, olderWork]);
  await pool.query(`update app.chapters c set head_revision_id=r.id from app.chapter_revisions r where r.chapter_id=c.id and c.work_id in ($1,$2)`, [work, olderWork]);
  await pool.query(`insert into app.work_releases (id,work_id,version,chapter_count,created_by_user_id) values ($1,$2,1,5000,$3)`, [release, work, user]);
  await pool.query(`insert into app.release_items (release_id,chapter_id,revision_id,editorial_position,label_raw,title)
    select $1,c.id,r.id,c.editorial_position,c.label_raw,r.title from app.chapters c join app.chapter_revisions r on r.id=c.head_revision_id where c.work_id=$2`, [release, work]);
  await pool.query(`update app.works set active_release_id=$1 where id=$2`, [release, work]);
  const chapters = (await pool.query(`select id,head_revision_id from app.chapters where work_id=$1 order by editorial_position`, [work])).rows;
  first = chapters[0].id; current = chapters[846].id; last = chapters[4999].id;
  const old = (await pool.query(`select id,head_revision_id from app.chapters where work_id=$1`, [olderWork])).rows[0];
  olderChapter = old.id; olderRevision = old.head_revision_id;
  await pool.query(`insert into app.bookmarks (user_id,work_id,chapter_id,revision_id,paragraph_index,note)
    select $1,$2,$3,$4,4,'seed-' || n from generate_series(1,510) n`, [user, work, first, chapters[0].head_revision_id]);
  await pool.query(`insert into app.bookmarks (user_id,work_id,chapter_id,revision_id,paragraph_index,note,created_at)
    values ($1,$2,$3,$4,7,'older note',now() - interval '1 year')`, [user, olderWork, olderChapter, olderRevision]);
  await pool.query(`update app.chapters set label_raw='草稿' where id=$1`, [current]);
});
after(async () => {
  try {
    await pool.query(`delete from app.bookmarks where user_id in ($1,$2)`, [user, other]);
    await pool.query(`update app.works set active_release_id=null where id in ($1,$2)`, [work, olderWork]);
    await pool.query(`delete from app.release_items where release_id in (select id from app.work_releases where work_id in ($1,$2))`, [work, olderWork]);
    await pool.query(`delete from app.work_releases where work_id in ($1,$2)`, [work, olderWork]);
    await pool.query(`update app.chapters set head_revision_id=null where work_id in ($1,$2)`, [work, olderWork]);
    await pool.query(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id in ($1,$2))`, [work, olderWork]);
    await pool.query(`delete from app.chapters where work_id in ($1,$2)`, [work, olderWork]);
    await pool.query(`delete from app.works where id in ($1,$2)`, [work, olderWork]);
    await pool.query(`delete from app.users where id in ($1,$2)`, [user, other]);
  } finally { await pool.end(); }
});
test('TOC: first/middle/latest, bounded metadata and continuous bidirectional ranges', async () => {
  const middle = await page(`limit=100&aroundChapterId=${current}`);
  assert.equal(middle.total, 5000); assert.equal(middle.chapters.length, 100); assert.ok(middle.offset > 700);
  assert.equal(middle.chapters.find((c) => c.id === current)?.labelRaw, '第12章（上）');
  assert.equal((await page(`aroundChapterId=${first}`)).chapters[0].id, first);
  assert.equal((await page('latest=true')).chapters.at(-1)?.id, last);
  assert.equal((await page(`aroundChapterId=${last}`)).chapters.at(-1)?.id, last);
  assert.equal((await page(`aroundChapterId=${randomUUID()}`)).anchorMissing, true);
  const found = [...middle.chapters];
  let start = middle.offset;
  while (start > 0) {
    const before = await page(`limit=${Math.min(500, start)}&offset=${Math.max(0, start - 500)}&version=${middle.version}`);
    found.unshift(...before.chapters); start = before.offset;
  }
  let next = middle.nextOffset;
  while (next !== null) {
    const after = await page(`limit=500&offset=${next}&version=${middle.version}`);
    found.push(...after.chapters); next = after.nextOffset;
  }
  assert.equal(found.length, 5000); assert.equal(new Set(found.map((c) => c.id)).size, 5000);
  assert.deepEqual(found.map((c) => c.editorialPosition), Array.from({ length: 5000 }, (_, i) => (i + 1) * 3));
});
test('TOC: full metadata search across scripts, raw labels and reverse editorial paging', async () => {
  const simplified = await page(`q=${encodeURIComponent('龙门')}&limit=1&order=desc`);
  assert.equal(simplified.total, 2); assert.equal(simplified.chapters[0].labelRaw, '第12章（下）');
  const traditional = await page(`q=${encodeURIComponent('龍門')}&limit=1&order=desc&offset=1&version=${simplified.version}`);
  assert.equal(traditional.chapters[0].id, current);
  assert.equal((await page('q=12.10')).chapters[0].labelRaw, '12.10');
  assert.equal((await page('q=missing')).total, 0);
  assert.equal((await page('order=desc')).chapters[0].id, last);
  assert.equal((await page('order=desc&latest=true')).chapters[0].id, last);
  let next: number | null = 0;
  const positions: number[] = [];
  while (next !== null) {
    const result = await page(`q=${encodeURIComponent('故事')}&order=desc&limit=500&offset=${next}`);
    positions.push(...result.chapters.map((c) => c.editorialPosition)); next = result.nextOffset;
  }
  assert.deepEqual(positions, Array.from({ length: 5000 }, (_, i) => (5000 - i) * 3));
  assert.equal((await toc('order=title')).status, 400);
});
test('bookmarks: owner-wide work choices and paging include records beyond 500', async () => {
  assert.equal((await app.request('/api/me/bookmarks')).status, 401);
  const response = await (await mine()).json();
  assert.equal(response.total, 511); assert.equal(response.bookmarks.length, 100); assert.equal(response.works.length, 2);
  assert.ok(response.works.some((entry: { id: string }) => entry.id === olderWork));
  const filtered = await (await mine(`workId=${olderWork}`)).json();
  assert.equal(filtered.bookmarks[0].note, 'older note'); assert.equal(filtered.total, 1);
  const ids = new Set<string>();
  let next: number | null = 0;
  while (next !== null) {
    const result = await (await mine(`offset=${next}`)).json();
    for (const entry of result.bookmarks) { assert.ok(!ids.has(entry.id)); ids.add(entry.id); }
    next = result.nextOffset;
  }
  assert.equal(ids.size, 511);
  const unrelated = await (await app.request('/api/me/bookmarks', { headers: { 'test-user': other } })).json();
  assert.equal(unrelated.total, 0); assert.deepEqual(unrelated.works, []);
});
test('bookmarks: edit/clear note, length boundary, ownership and delete/undo frozen anchors', async () => {
  const created = await write('/api/me/bookmarks', 'POST', { workId: olderWork, chapterId: olderChapter, revisionId: olderRevision, paragraphIndex: 8 });
  assert.equal(created.status, 201);
  const { id } = await created.json(); const path = `/api/me/bookmarks/${id}`;
  const note = '<script>plain text only</script>';
  assert.equal((await write(path, 'PATCH', { note })).status, 200);
  assert.equal((await write(path, 'PATCH', { note: 'x'.repeat(501) })).status, 400);
  assert.equal((await write(path, 'PATCH', { note: 'private' }, other)).status, 404);
  let stored = (await pool.query(`select * from app.bookmarks where id=$1`, [id])).rows[0];
  assert.equal(stored.note, note); assert.equal(stored.paragraph_index, 8);
  assert.equal(stored.chapter_id, olderChapter); assert.equal(stored.revision_id, olderRevision);
  assert.equal((await write(path, 'PATCH', { note: '' })).status, 200);
  assert.equal((await write(path, 'PATCH', { note: 'x'.repeat(500) })).status, 200);
  stored = (await pool.query(`select * from app.bookmarks where id=$1`, [id])).rows[0];
  assert.equal((await write(path, 'DELETE')).status, 200);
  const undo = await write('/api/me/bookmarks', 'POST', { workId: stored.work_id, chapterId: stored.chapter_id,
    revisionId: stored.revision_id, paragraphIndex: stored.paragraph_index, note: stored.note });
  assert.equal(undo.status, 201);
  const restored = (await pool.query(`select * from app.bookmarks where id=$1`, [(await undo.json()).id])).rows[0];
  for (const key of ['note', 'work_id', 'chapter_id', 'revision_id', 'paragraph_index']) assert.equal(restored[key], stored[key]);
});
test('TOC: new release invalidates pages, missing current falls back, draft head stays admin-only', async () => {
  const initial = await page(); const newer = randomUUID();
  await pool.query(`insert into app.work_releases (id,work_id,version,chapter_count,created_by_user_id) values ($1,$2,2,4999,$3)`, [newer, work, user]);
  await pool.query(`insert into app.release_items select $1,chapter_id,revision_id,editorial_position,volume_id,label_raw,title
    from app.release_items where release_id=$2 and chapter_id<>$3`, [newer, release, current]);
  await pool.query(`update app.works set active_release_id=$1 where id=$2`, [newer, work]);
  const stale = await toc(`offset=100&version=${initial.version}`);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error, 'toc_version_changed');
  const renewed = await page(`aroundChapterId=${current}`);
  assert.equal(renewed.anchorMissing, true); assert.equal(renewed.total, 4999); assert.equal(renewed.chapters[0].id, first);
  await pool.query(`update app.works set visibility='draft' where id=$1`, [work]);
  assert.equal((await toc()).status, 403);
  const draft = await app.request(`/api/reader/works/${work}/chapters?aroundChapterId=${current}`, { headers: { 'test-role': 'admin' } });
  assert.equal(draft.status, 200);
  const head = await draft.json(); assert.ok(head.version.startsWith('head:'));
  assert.equal(head.chapters.find((c: { id: string }) => c.id === current).labelRaw, '草稿');
});
