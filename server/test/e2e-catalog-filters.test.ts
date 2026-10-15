// ER-005/006: list/count predicates and cursor ownership through the real API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { newSession } from '../src/auth/session.ts';
const { app } = await import('../src/index.ts');
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const query = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
const suffix = crypto.randomUUID().slice(0, 8);
const author = `catalog-filters-${suffix}`;
const users: string[] = [];
const cookies: string[] = [];
const workIds: string[] = [];
const tagIds: string[] = [];
let categoryId = '';
const base = () => `q=${author}&sort=title`;
async function response(path: string, cookie?: string) {
  return app.request(path, cookie ? { headers: { cookie } } : undefined);
}
async function ids(filters: string, cookie?: string) {
  const all: string[] = [];
  let cursor: string | null = null;
  do {
    const res = await response(`/api/works?${base()}&limit=2&${filters}${cursor ? `&cursor=${cursor}` : ''}`, cookie);
    assert.equal(res.status, 200);
    const body = await res.json() as { works: Array<{ id: string }>; nextCursor: string | null };
    all.push(...body.works.map((w) => w.id));
    cursor = body.nextCursor;
    assert.ok(all.length <= 6, 'pagination must terminate without duplicates');
  } while (cursor);
  const count = await response(`/api/works/count?${base()}&${filters}`, cookie);
  assert.equal(count.status, 200);
  assert.equal((await count.json() as { count: number }).count, all.length);
  return all;
}
before(async () => {
  for (let i = 0; i < 2; i++) {
    const [u] = await query(`insert into app.users (username,email,password_hash,role) values ($1,$2,'unused','member') returning id`,
      [`cat-${suffix}-${i}`, `cat-${suffix}-${i}@example.test`]);
    users.push(u.id);
    const session = newSession();
    await query(`insert into app.sessions (id,user_id,expires_at) values ($1,$2,$3)`, [session.id, u.id, session.expiresAt]);
    cookies.push(`ebook_session=${session.token}`);
  }
  const [category] = await query(`insert into app.categories (display_name) values ($1) returning id`, [`cat-${suffix}`]);
  categoryId = category.id;
  for (const name of ['玄幻', '系統', '慢熱']) {
    const [tag] = await query(`insert into app.tags (display_name) values ($1) returning id`, [`${name}-${suffix}`]);
    tagIds.push(tag.id);
  }
  for (let i = 0; i < 6; i++) {
    const [w] = await query(`insert into app.works (title,author,work_type,serial_status,visibility) values ($1,$2,'serial','ongoing','public') returning id`,
      [`${author}-${i}`, author]);
    workIds.push(w.id);
    const [r] = await query(`insert into app.work_releases (work_id,version,chapter_count,created_by_user_id) values ($1,1,0,$2) returning id`, [w.id, users[0]]);
    await query(`update app.works set active_release_id=$1 where id=$2`, [r.id, w.id]);
    await query(`insert into app.work_categories (work_id,category_id) values ($1,$2)`, [w.id, categoryId]);
    for (const index of [[0, 1], [0, 2], [0, 1, 2], [0], [], [2]][i]!) {
      await query(`insert into app.work_tags (work_id,tag_id) values ($1,$2)`, [w.id, tagIds[index]]);
    }
  }
  for (const [i, status] of ['finished', 'reading', 'want', 'paused'].entries()) {
    await query(`insert into app.user_library (user_id,work_id,reading_status) values ($1,$2,$3)`, [users[0], workIds[i], status]);
  }
  await query(`insert into app.user_library (user_id,work_id,reading_status) values ($1,$2,'finished')`, [users[1], workIds[3]]);
});
after(async () => {
  for (const id of workIds) {
    await query(`delete from app.user_library where work_id=$1`, [id]);
    await query(`delete from app.work_tags where work_id=$1`, [id]);
    await query(`delete from app.work_categories where work_id=$1`, [id]);
    await query(`update app.works set active_release_id=null where id=$1`, [id]);
    await query(`delete from app.work_releases where work_id=$1`, [id]);
    await query(`delete from app.works where id=$1`, [id]);
  }
  if (categoryId) await query(`delete from app.categories where id=$1`, [categoryId]);
  for (const id of tagIds) await query(`delete from app.tags where id=$1`, [id]);
  for (const id of users) {
    await query(`delete from app.sessions where user_id=$1`, [id]);
    await query(`delete from app.users where id=$1`, [id]);
  }
  await pool.end();
});
test('ER-005 exclusion composes with include all/any, keyword, category, type, status and preserves untagged works', async () => {
  const [fantasy, system, slow] = tagIds;
  const filters = `type=serial&serialStatus=ongoing&categoryIds=${categoryId}&excludeTagIds=${system}`;
  assert.deepEqual(await ids(`${filters}&tagIds=${fantasy}`), [workIds[1], workIds[3]]);
  assert.deepEqual(await ids(`${filters}&tagIds=${fantasy},${slow}&tagMode=all`), [workIds[1]]);
  assert.deepEqual(await ids(`${filters}&tagIds=${fantasy},${slow}&tagMode=any`), [workIds[1], workIds[3], workIds[5]]);
  assert.deepEqual(await ids(`excludeTagIds=${system},${slow}`), [workIds[3], workIds[4]]);
  assert.deepEqual(await ids(filters), await ids(filters, cookies[0]));
  assert.deepEqual(await ids(`excludeTagIds=${tagIds.join(',')}`), [workIds[4]]);
});
test('ER-005 exclusions normalize duplicates/order/case and reject changed filters or invalid ids', async () => {
  const first = await response(`/api/works?${base()}&limit=1&excludeTagIds=${tagIds[1]},${tagIds[2]}`);
  const { nextCursor } = await first.json() as { nextCursor: string };
  assert.ok(nextCursor);
  const same = await response(`/api/works?${base()}&excludeTagIds=${tagIds[2].toUpperCase()},${tagIds[1]},${tagIds[1]}&cursor=${nextCursor}`);
  assert.equal(same.status, 200);
  const changed = await response(`/api/works?${base()}&excludeTagIds=${tagIds[1]}&cursor=${nextCursor}`);
  assert.equal(changed.status, 400);
  assert.equal((await changed.json() as { error: string }).error, 'cursor_filter_mismatch');
  for (const endpoint of ['/api/works', '/api/works/count']) {
    const bad = await response(`${endpoint}?excludeTagIds=bad`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_filter', field: 'ids' });
    const overlap = await response(`${endpoint}?tagIds=${tagIds[0]}&excludeTagIds=${tagIds[0]}`);
    assert.equal(overlap.status, 400);
    assert.deepEqual(await overlap.json(), { error: 'invalid_filter', field: 'excludeTagIds' });
  }
  // Existing included-tag behavior uses ids even when inactive; exclusion is identical.
  await query(`update app.tags set is_active=false where id=$1`, [tagIds[2]]);
  assert.deepEqual(await ids(`excludeTagIds=${tagIds[2]}`), [workIds[0], workIds[3], workIds[4]]);
  await query(`update app.tags set is_active=true where id=$1`, [tagIds[2]]);
});
test('ER-006 hides only current member manual finished state across pages and count; updates reappear', async () => {
  assert.deepEqual(await ids('hideFinished=true', cookies[0]), workIds.slice(1));
  assert.deepEqual(await ids('hideFinished=true', cookies[1]), workIds.filter((_, i) => i !== 3));
  assert.deepEqual(await ids(`hideFinished=true&excludeTagIds=${tagIds[1]}`, cookies[0]), [workIds[1], workIds[3], workIds[4], workIds[5]]);
  assert.deepEqual(await ids('hideFinished=false', cookies[0]), workIds);
  const changed = await app.request(`/api/me/library/${workIds[0]}`, { method: 'PATCH', headers: { cookie: cookies[0], 'content-type': 'application/json' }, body: JSON.stringify({ readingStatus: 'reading' }) });
  assert.equal(changed.status, 200);
  assert.deepEqual(await ids('hideFinished=true', cookies[0]), workIds);
  await query(`update app.user_library set reading_status='finished' where user_id=$1 and work_id=$2`, [users[0], workIds[0]]);
});
test('ER-006 rejects anonymous/expired sessions, binds cursor to account, and prevents cached private reuse', async () => {
  for (const endpoint of ['/api/works', '/api/works/count']) {
    for (const cookie of [undefined, 'ebook_session=expired']) {
      const denied = await response(`${endpoint}?hideFinished=true`, cookie);
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), { error: 'unauthenticated', field: 'hideFinished' });
    }
    const invalid = await response(`${endpoint}?hideFinished=yes`, cookies[0]);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'invalid_filter', field: 'hideFinished' });
  }
  const first = await response(`/api/works?${base()}&hideFinished=true&limit=2`, cookies[0]);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.equal(first.headers.get('vary'), 'Cookie');
  const { nextCursor } = await first.json() as { nextCursor: string };
  assert.ok(nextCursor);
  for (const [filters, cookie] of [['hideFinished=true', cookies[1]], ['hideFinished=false', cookies[0]]] as const) {
    const crossed = await response(`/api/works?${base()}&${filters}&cursor=${nextCursor}`, cookie);
    assert.equal(crossed.status, 400);
    assert.deepEqual(await crossed.json(), { error: 'cursor_filter_mismatch' });
  }
});
