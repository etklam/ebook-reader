// L2 E2E acceptance (Phase 3.1, CAT-03): keyset pagination must not drop or
// duplicate a work when the catalog changes between page requests.
//
// This is the property offset pagination could not hold: with LIMIT/OFFSET, a
// publication landing between page 1 and page 2 shifts every later row by one,
// so the reader silently never sees one book. The test publishes mid-scroll and
// asserts the full set is still enumerated exactly once.
//
// Run: pnpm --filter server test:e2e   (needs `pnpm db:up` + `pnpm db:migrate`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-pag-'));
const { app } = await import('../src/index.ts');
const { hashPassword } = await import('../src/auth/password.ts');

const SUFFIX = Math.random().toString(36).slice(2, 8);
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

const AUTHOR = `分頁作者-${SUFFIX}`;
let adminUserId = '';
let memberCookie = '';
const seeded: Array<{ workId: string; releaseId: string; chapterId: string }> = [];

// Published works with controlled publish timestamps so the `updated` sort
// order is deterministic: index 0 is newest.
async function seedPublished(index: number, publishedAt: string) {
  const [w] = await q(
    `insert into app.works (title, author, work_type, serial_status, visibility)
     values ($1, $2, 'serial', 'ongoing', 'public') returning id`,
    [`分頁樣本-${SUFFIX}-${String(index).padStart(2, '0')}`, AUTHOR]);
  const [ch] = await q(
    `insert into app.chapters (work_id, label_raw, editorial_position)
     values ($1, '第 1 章', 1) returning id`, [w.id]);
  const [rev] = await q(
    `insert into app.chapter_revisions
       (chapter_id, title, content_key, body_compare_hash, revision_hash, processor_version)
     values ($1, 't', $2, 'h', 'h', 'test') returning id`,
    [ch.id, `ab/${crypto.randomUUID()}.txt`]);
  await q(`update app.chapters set head_revision_id = $1 where id = $2`, [rev.id, ch.id]);
  const [rel] = await q(
    `insert into app.work_releases (work_id, version, chapter_count, created_by_user_id, published_at)
     values ($1, 1, 1, $2, $3::timestamptz) returning id`,
    [w.id, adminUserId, publishedAt]);
  await q(
    `insert into app.release_items (release_id, chapter_id, revision_id, editorial_position, label_raw, title)
     values ($1, $2, $3, 1, '第 1 章', 't')`, [rel.id, ch.id, rev.id]);
  await q(`update app.works set active_release_id = $1 where id = $2`, [rel.id, w.id]);
  const row = { workId: w.id, releaseId: rel.id, chapterId: ch.id };
  seeded.push(row);
  return row;
}

interface Page { works: Array<{ id: string }>; nextCursor: string | null; limit: number }
const fetchPage = async (query: string): Promise<Page> => {
  const res = await app.request(`/api/works?${query}`);
  assert.equal(res.status, 200, `GET /api/works?${query} → ${res.status}`);
  return await res.json() as Page;
};

// walk every page, returning ids in order
async function drain(base: string, opts: { afterFirstPage?: () => Promise<void> } = {}): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page: Page = await fetchPage(`${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    ids.push(...page.works.map((w) => w.id));
    pages += 1;
    if (pages === 1 && opts.afterFirstPage) await opts.afterFirstPage();
    cursor = page.nextCursor;
    if (!cursor) break;
    assert.ok(pages < 50, 'pagination did not terminate');
  }
  return ids;
}

before(async () => {
  const email = `e2e-pag-admin-${SUFFIX}@example.test`;
  const [a] = await q(
    `insert into app.users (username, email, password_hash, role)
     values ($1, $2, $3, 'admin') returning id`,
    [`e2e-pag-admin-${SUFFIX}`, email, await hashPassword('pw-12345678')]);
  adminUserId = a.id;
  await q(
    `insert into app.users (username, email, password_hash, role)
     values ($1, $2, $3, 'member')`,
    [`e2e-pag-member-${SUFFIX}`, `e2e-pag-member-${SUFFIX}@example.test`, await hashPassword('pw-12345678')]);
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `e2e-pag-member-${SUFFIX}@example.test`, password: 'pw-12345678' }),
  });
  assert.equal(login.status, 200);
  memberCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

  // 7 works, newest first when sorted by `updated`
  for (let i = 0; i < 7; i++) {
    await seedPublished(i, `2026-09-${String(20 - i).padStart(2, '0')}T00:00:00Z`);
  }
});

after(async () => {
  for (const s of seeded) {
    await q(`update app.works set active_release_id = null where id = $1`, [s.workId]);
    await q(`delete from app.release_items where release_id = $1`, [s.releaseId]);
    await q(`delete from app.work_releases where work_id = $1`, [s.workId]);
    await q(`delete from app.user_library where work_id = $1`, [s.workId]);
    await q(`update app.chapters set head_revision_id = null where work_id = $1`, [s.workId]);
    await q(`delete from app.chapter_revisions where chapter_id = $1`, [s.chapterId]);
    await q(`delete from app.chapters where work_id = $1`, [s.workId]);
    await q(`delete from app.works where id = $1`, [s.workId]);
  }
  await q(`delete from app.sessions where user_id in (select id from app.users where email like $1)`,
    [`e2e-pag-%-${SUFFIX}@example.test`]);
  await q(`delete from app.users where email like $1`, [`e2e-pag-%-${SUFFIX}@example.test`]);
  await pool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

const scope = `q=${encodeURIComponent(AUTHOR)}&limit=3`;

test('PAG-01: paging enumerates every work exactly once, in sort order', async () => {
  const ids = await drain(`${scope}&sort=updated`);
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7, 'no duplicates');
  // seeded newest-first: published_at descends with index
  assert.deepEqual(ids, seeded.map((s) => s.workId));
});

test('PAG-02: the last page reports nextCursor = null', async () => {
  const first = await fetchPage(`${scope}&sort=updated`);
  assert.equal(first.works.length, 3);
  assert.ok(first.nextCursor, 'a further page exists');

  const all = await fetchPage(`q=${encodeURIComponent(AUTHOR)}&limit=50&sort=updated`);
  assert.equal(all.works.length, 7);
  assert.equal(all.nextCursor, null, 'an exhausted list must not offer a cursor');
});

test('PAG-03 (CAT-03): publishing mid-pagination drops no work and repeats none', async () => {
  let injected: string | null = null;
  const ids = await drain(`${scope}&sort=updated`, {
    // after page 1, publish a work that sorts to the TOP of the list — the
    // case that shifts an offset window and makes it skip a row
    afterFirstPage: async () => {
      const row = await seedPublished(99, '2026-09-30T00:00:00Z');
      injected = row.workId;
    },
  });

  assert.ok(injected, 'the mid-scroll publication happened');
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${JSON.stringify(ids)}`);

  // Every work that existed when paging started must appear. The newly
  // published one sorts above the cursor, so not seeing it is correct —
  // what must never happen is losing one of the original seven.
  const original = seeded.filter((s) => s.workId !== injected).map((s) => s.workId);
  for (const id of original) {
    assert.ok(ids.includes(id), `work ${id} was dropped by pagination`);
  }
  assert.ok(!ids.includes(injected!), 'a work published above the cursor is not re-shown mid-scroll');
});

test('PAG-04 (CAT-03): unpublishing mid-pagination does not shift later pages', async () => {
  const target = seeded[1];        // on page 1, so pulling it cannot shift page 2
  const ids = await drain(`${scope}&sort=updated`, {
    afterFirstPage: async () => {
      await q(`update app.works set visibility = 'draft' where id = $1`, [target.workId]);
    },
  });
  await q(`update app.works set visibility = 'public' where id = $1`, [target.workId]);

  assert.equal(new Set(ids).size, ids.length, 'no duplicates after a mid-scroll removal');
  // with an offset, removing a page-1 row pulls page 2 up by one and the
  // reader never sees the work that moved across the boundary
  const expected = seeded.filter((s) => s.workId !== target.workId).map((s) => s.workId);
  for (const id of expected) {
    assert.ok(ids.includes(id), `work ${id} was skipped after a mid-scroll removal`);
  }
});

test('PAG-05: a cursor carried to a different filter set is refused', async () => {
  const first = await fetchPage(`${scope}&sort=updated`);
  assert.ok(first.nextCursor);

  // same cursor, different sort → must not silently page the new ordering
  const mismatched = await app.request(
    `/api/works?${scope}&sort=title&cursor=${encodeURIComponent(first.nextCursor!)}`);
  assert.equal(mismatched.status, 400);
  assert.equal(((await mismatched.json()) as { error: string }).error, 'cursor_filter_mismatch');

  // same cursor, extra filter → likewise
  const narrowed = await app.request(
    `/api/works?${scope}&sort=updated&type=short_story&cursor=${encodeURIComponent(first.nextCursor!)}`);
  assert.equal(narrowed.status, 400);

  const garbage = await app.request(`/api/works?${scope}&cursor=not-a-cursor`);
  assert.equal(garbage.status, 400);
  assert.equal(((await garbage.json()) as { error: string }).error, 'invalid_cursor');
});

test('PAG-06: sort=title pages correctly too', async () => {
  const ids = await drain(`${scope}&sort=title`);
  assert.equal(new Set(ids).size, ids.length);
  const titles = await q(
    `select id, title from app.works where author = $1 and visibility = 'public'
       and active_release_id is not null order by title asc, id asc`, [AUTHOR]);
  assert.deepEqual(ids, titles.map((r: { id: string }) => r.id));
});

test('PAG-07: the member shelf is keyset-paginated and bounded', async () => {
  for (const s of seeded) {
    const res = await app.request(`/api/me/library/${s.workId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberCookie },
      body: '{}',
    });
    assert.equal(res.status, 200);
  }
  const first = await app.request('/api/me/library?limit=3', { headers: { cookie: memberCookie } });
  const page1 = await first.json() as { works: Array<{ workId: string }>; nextCursor: string | null };
  assert.equal(page1.works.length, 3);
  assert.ok(page1.nextCursor, 'a larger shelf must offer a cursor');

  const ids: string[] = page1.works.map((w) => w.workId);
  let cursor = page1.nextCursor;
  while (cursor) {
    const res = await app.request(`/api/me/library?limit=3&cursor=${encodeURIComponent(cursor)}`,
      { headers: { cookie: memberCookie } });
    assert.equal(res.status, 200);
    const page = await res.json() as { works: Array<{ workId: string }>; nextCursor: string | null };
    ids.push(...page.works.map((w) => w.workId));
    cursor = page.nextCursor;
  }
  assert.equal(new Set(ids).size, ids.length, 'the shelf must not repeat a work');
  for (const s of seeded) assert.ok(ids.includes(s.workId), `shelf dropped ${s.workId}`);

  // another member's cursor cannot be used to read this shelf: the fingerprint
  // is scoped to the user id
  const [other] = await q(
    `insert into app.users (username, email, password_hash, role)
     values ($1, $2, $3, 'member') returning id`,
    [`e2e-pag-other-${SUFFIX}`, `e2e-pag-other-${SUFFIX}@example.test`, await hashPassword('pw-12345678')]);
  assert.ok(other.id);
  const otherLogin = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `e2e-pag-other-${SUFFIX}@example.test`, password: 'pw-12345678' }),
  });
  const otherCookie = (otherLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const crossed = await app.request(
    `/api/me/library?limit=3&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    { headers: { cookie: otherCookie } });
  assert.equal(crossed.status, 400, 'a cursor from another member\'s shelf must be refused');
});
