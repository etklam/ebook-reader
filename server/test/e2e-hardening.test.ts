// L2 E2E acceptance (M7 Beta hardening). Each test pins one defect found in
// the pre-M7 audit, so a regression fails loudly instead of degrading quietly:
//
//   HRD-01  /api/works/count must apply the SAME filters as /api/works (§03A-F
//           "前端、API、count 查詢共用一個 filter predicate builder")
//   HRD-02  a malformed :workId is a 4xx, never an unhandled 500
//   HRD-03  progress/bookmarks must reject a chapter from a different work
//   HRD-04  a requested filter is never silently widened (§03A)
//   HRD-05  follows/seen clamps to the latest release that exists
//   HRD-06  login is throttled per account
//   HRD-07  every /api/admin/* module is guarded regardless of mount order
//   HRD-08  security headers present; unbounded bodies refused
//
// Run: pnpm --filter server test:e2e   (needs `pnpm db:up` + `pnpm db:migrate`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-hrd-'));
// a low per-account cap makes HRD-06 deterministic; the per-IP cap stays at its
// default so the logins this file performs during setup are unaffected
process.env.AUTH_RATE_LIMIT_MAX_PER_ACCOUNT = '3';
const { app } = await import('../src/index.ts');
const { hashPassword } = await import('../src/auth/password.ts');

const SUFFIX = Math.random().toString(36).slice(2, 8);
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

async function login(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `login ${email} → ${res.status}`);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

const GET = (path: string, cookie = '') =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);
const send = (method: string) => (path: string, cookie: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
const PUT = send('PUT');
const POST = send('POST');

let admin = '';
let member = '';
let adminUserId = '';
interface Seeded { workId: string; chapterId: string; revisionId: string; releaseId: string }
let serialWork: Seeded;
let shortWork: Seeded;
let tagId = '';

// Minimal published work built directly in SQL: this file tests the HTTP edge,
// not the import pipeline (which e2e-import/incremental/overwrite already
// cover), so paying for a 180-chapter parse here would only slow the suite.
async function seedPublished(title: string, workType: 'serial' | 'short_story'): Promise<Seeded> {
  // works_type_status_ck: a short_story carries no serial state
  const [w] = await q(
    `insert into app.works (title, author, work_type, serial_status, visibility)
     values ($1, $2, $3, $4, 'public') returning id`,
    [`${title}-${SUFFIX}`, `硬化作者-${SUFFIX}`, workType, workType === 'serial' ? 'ongoing' : null]);
  const [ch] = await q(
    `insert into app.chapters (work_id, label_raw, editorial_position) values ($1, '第 1 章', 1) returning id`,
    [w.id]);
  const [rev] = await q(
    `insert into app.chapter_revisions
       (chapter_id, title, content_key, body_compare_hash, revision_hash, processor_version)
     values ($1, '首章', $2, 'h', 'h', 'test') returning id`,
    [ch.id, `ab/${crypto.randomUUID()}.txt`]);
  await q(`update app.chapters set head_revision_id=$1 where id=$2`, [rev.id, ch.id]);
  const [rel] = await q(
    `insert into app.work_releases (work_id, version, chapter_count, created_by_user_id)
     values ($1, 1, 1, $2) returning id`,
    [w.id, adminUserId]);
  await q(
    `insert into app.release_items (release_id, chapter_id, revision_id, editorial_position, label_raw, title)
     values ($1, $2, $3, 1, '第 1 章', '首章')`,
    [rel.id, ch.id, rev.id]);
  await q(`update app.works set active_release_id=$1 where id=$2`, [rel.id, w.id]);
  return { workId: w.id, chapterId: ch.id, revisionId: rev.id, releaseId: rel.id };
}

before(async () => {
  const email = (role: string) => `e2e-h-${role}-${SUFFIX}@example.test`;
  const [a] = await q(
    `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,'admin') returning id`,
    [`e2e-h-admin-${SUFFIX}`, email('admin'), await hashPassword('pw-12345678')]);
  adminUserId = a.id;
  await q(
    `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,'member')`,
    [`e2e-h-member-${SUFFIX}`, email('member'), await hashPassword('pw-12345678')]);
  admin = await login(email('admin'), 'pw-12345678');
  member = await login(email('member'), 'pw-12345678');

  serialWork = await seedPublished('硬化連載', 'serial');
  shortWork = await seedPublished('硬化短篇', 'short_story');
  [{ id: tagId }] = await q(
    `insert into app.tags (display_name) values ($1) returning id`, [`硬化標籤-${SUFFIX}`]);
  await q(`insert into app.work_tags (work_id, tag_id) values ($1, $2)`, [serialWork.workId, tagId]);
});

after(async () => {
  for (const w of [serialWork, shortWork]) {
    if (!w) continue;
    await q(`update app.works set active_release_id=null where id=$1`, [w.workId]);
    await q(`delete from app.release_items where release_id=$1`, [w.releaseId]);
    await q(`delete from app.work_releases where id=$1`, [w.releaseId]);
    await q(`delete from app.bookmarks where work_id=$1`, [w.workId]);
    await q(`delete from app.reading_progress where work_id=$1`, [w.workId]);
    await q(`delete from app.user_chapter_reads where chapter_id=$1`, [w.chapterId]);
    await q(`delete from app.user_follows where work_id=$1`, [w.workId]);
    await q(`delete from app.user_library where work_id=$1`, [w.workId]);
    await q(`delete from app.work_tags where work_id=$1`, [w.workId]);
    await q(`update app.chapters set head_revision_id=null where work_id=$1`, [w.workId]);
    await q(`delete from app.chapter_revisions where chapter_id=$1`, [w.chapterId]);
    await q(`delete from app.chapters where work_id=$1`, [w.workId]);
    await q(`delete from app.works where id=$1`, [w.workId]);
  }
  if (tagId) await q(`delete from app.tags where id=$1`, [tagId]);
  await q(`delete from app.sessions where user_id in (select id from app.users where email like $1)`,
    [`e2e-h-%-${SUFFIX}@example.test`]);
  await q(`delete from app.users where email like $1`, [`e2e-h-%-${SUFFIX}@example.test`]);
  await pool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

// --- HRD-01: count shares the list's filter predicate ------------------------
test('HRD-01: /api/works/count applies the same filters as /api/works', async () => {
  const countOf = async (query: string): Promise<number> =>
    ((await (await GET(`/api/works/count${query}`)).json()) as { count: number }).count;
  const listOf = async (query: string): Promise<string[]> =>
    ((await (await GET(`/api/works${query}&limit=50`)).json()) as { works: { id: string }[] })
      .works.map((w) => w.id);

  // a filter that matches exactly one of the two seeded works
  const author = `硬化作者-${SUFFIX}`;
  const bothQuery = `?q=${encodeURIComponent(author)}`;
  assert.equal(await countOf(bothQuery), 2, 'both seeded works match the author keyword');

  const serialQuery = `${bothQuery}&type=serial`;
  assert.equal(await countOf(serialQuery), 1);
  assert.deepEqual(await listOf(serialQuery), [serialWork.workId]);

  const shortQuery = `${bothQuery}&type=short_story`;
  assert.equal(await countOf(shortQuery), 1);
  assert.deepEqual(await listOf(shortQuery), [shortWork.workId]);

  // tag filter: only the serial work carries the tag
  const tagQuery = `${bothQuery}&tagIds=${tagId}&tagMode=all`;
  assert.equal(await countOf(tagQuery), 1);
  assert.deepEqual(await listOf(tagQuery), [serialWork.workId]);

  // a filter matching nothing must report 0, not the whole catalog
  assert.equal(await countOf('?q=zzz-no-such-work-zzz'), 0);

  // and count must reject exactly what the list rejects
  for (const bad of ['?type=nonsense', '?serialStatus=bogus', '?tagIds=not-a-uuid', '?sort=whatever']) {
    const list = await GET(`/api/works${bad}`);
    const count = await GET(`/api/works/count${bad}`);
    assert.equal(list.status, 400, `list ${bad}`);
    assert.equal(count.status, 400, `count ${bad} must not accept what the list refuses`);
  }
});

// --- HRD-02: malformed path params are 4xx, not unhandled 500 ----------------
test('HRD-02: a non-UUID :workId never produces a 500', async () => {
  const cases: [string, RequestInit][] = [
    ['/api/me/library/not-a-uuid', { method: 'DELETE', headers: { cookie: member } }],
    ['/api/me/follows/not-a-uuid', { method: 'DELETE', headers: { cookie: member } }],
    ['/api/me/progress/not-a-uuid', { headers: { cookie: member } }],
    ['/api/me/follows/not-a-uuid/seen', { method: 'POST', headers: { 'content-type': 'application/json', cookie: member }, body: '{}' }],
    ['/api/me/reads?workId=not-a-uuid', { headers: { cookie: member } }],
    ['/api/me/bookmarks?workId=not-a-uuid', { headers: { cookie: member } }],
    ['/api/me/bookmarks/not-a-uuid', { method: 'DELETE', headers: { cookie: member } }],
    ['/api/works/not-a-uuid', {}],
    ['/api/reader/works/not-a-uuid', {}],
    ['/api/reader/chapters/not-a-uuid', {}],
  ];
  for (const [path, init] of cases) {
    const res = await app.request(path, init);
    assert.ok(res.status >= 400 && res.status < 500, `${path} → ${res.status} (expected 4xx)`);
    // the body must be parseable JSON with a code, never Hono's bare text 500
    const body = await res.json() as { error?: string };
    assert.ok(typeof body.error === 'string' && body.error.length > 0, `${path} body: ${JSON.stringify(body)}`);
  }
});

test('HRD-02: an unknown route answers JSON, not HTML or plain text', async () => {
  const res = await GET('/api/no/such/route');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

// --- HRD-03: cross-work chapter references are rejected ----------------------
test('HRD-03: progress cannot point at another work\'s chapter', async () => {
  // sanity: the same payload against the chapter's OWN work is accepted
  const ok = await PUT(`/api/me/progress/${shortWork.workId}`, member, {
    chapterId: shortWork.chapterId, revisionId: shortWork.revisionId, paragraphIndex: 0, baseVersion: 0,
  });
  assert.equal(ok.status, 200);

  const crossed = await PUT(`/api/me/progress/${serialWork.workId}`, member, {
    chapterId: shortWork.chapterId, revisionId: shortWork.revisionId, paragraphIndex: 0, baseVersion: 0,
  });
  assert.equal(crossed.status, 400, 'a chapter of another work must not become this work\'s position');
  assert.equal(((await crossed.json()) as { error: string }).error, 'invalid_request');

  // nothing was written for the other work
  const stored = await q(`select 1 from app.reading_progress where work_id=$1`, [serialWork.workId]);
  assert.equal(stored.length, 0);
});

test('HRD-03: bookmarks cannot point at another work\'s chapter', async () => {
  const ok = await POST('/api/me/bookmarks', member, {
    workId: shortWork.workId, chapterId: shortWork.chapterId, revisionId: shortWork.revisionId, paragraphIndex: 0,
  });
  assert.equal(ok.status, 201);

  const crossed = await POST('/api/me/bookmarks', member, {
    workId: serialWork.workId, chapterId: shortWork.chapterId, revisionId: shortWork.revisionId, paragraphIndex: 0,
  });
  assert.equal(crossed.status, 400);
  const stored = await q(`select 1 from app.bookmarks where work_id=$1`, [serialWork.workId]);
  assert.equal(stored.length, 0);
});

// --- HRD-04: filters are never silently widened ------------------------------
test('HRD-04: an unparseable workId filter errors instead of returning everything', async () => {
  // the member owns a bookmark on shortWork (HRD-03); an invalid filter must
  // NOT fall through to "no filter" and hand back the whole history
  const valid = await GET(`/api/me/bookmarks?workId=${shortWork.workId}`, member);
  assert.equal(valid.status, 200);
  assert.equal(((await valid.json()) as { bookmarks: unknown[] }).bookmarks.length, 1);

  for (const path of ['/api/me/bookmarks?workId=garbage', '/api/me/reads?workId=garbage']) {
    const res = await GET(path, member);
    assert.equal(res.status, 400, path);
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_filter');
  }
});

// --- HRD-05: seen version is clamped to reality -------------------------------
test('HRD-05: follows/seen clamps to the newest existing release', async () => {
  assert.equal((await PUT(`/api/me/follows/${serialWork.workId}`, member, {})).status, 200);

  const absurd = await POST(`/api/me/follows/${serialWork.workId}/seen`, member, { releaseVersion: 999_999_999 });
  assert.equal(absurd.status, 200);
  assert.equal(((await absurd.json()) as { lastSeenVersion: number }).lastSeenVersion, 1,
    'an out-of-range version must be clamped, not stored — otherwise every future release counts as seen');
  const [row] = await q(
    `select last_seen_release_version as v from app.user_follows where work_id=$1`, [serialWork.workId]);
  assert.equal(row.v, 1);

  assert.equal((await POST(`/api/me/follows/${serialWork.workId}/seen`, member, { releaseVersion: -5 })).status, 400);

  // marking seen on a work the member does not follow is a no-op, not an error
  const notFollowed = await POST(`/api/me/follows/${shortWork.workId}/seen`, member, {});
  assert.equal(notFollowed.status, 200);
  assert.deepEqual(await notFollowed.json(), { ok: true, following: false, lastSeenVersion: null });
});

// --- HRD-06: login throttling ------------------------------------------------
test('HRD-06: repeated failed logins for one account are throttled', async () => {
  const target = `e2e-h-throttle-${SUFFIX}@example.test`;
  const attempt = () => app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: target, password: 'wrong-password' }),
  });
  // AUTH_RATE_LIMIT_MAX_PER_ACCOUNT = 3 for this file
  for (let i = 0; i < 3; i++) {
    assert.equal((await attempt()).status, 401, `attempt ${i + 1} should still be evaluated`);
  }
  const throttled = await attempt();
  assert.equal(throttled.status, 429);
  assert.equal(((await throttled.json()) as { error: string }).error, 'too_many_attempts');
  assert.ok(Number(throttled.headers.get('retry-after')) >= 1, 'Retry-After must be set');

  // the throttle is per account: a different address is unaffected
  const other = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `e2e-h-other-${SUFFIX}@example.test`, password: 'wrong-password' }),
  });
  assert.equal(other.status, 401, 'one throttled account must not lock out everyone else');
});

test('HRD-06: a successful login clears the account throttle', async () => {
  const email = `e2e-h-member-${SUFFIX}@example.test`;
  // two failures, then a success, then two more failures must still be evaluated
  for (let i = 0; i < 2; i++) {
    const bad = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
    assert.equal(bad.status, 401);
  }
  await login(email, 'pw-12345678');
  for (let i = 0; i < 2; i++) {
    const bad = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
    assert.equal(bad.status, 401, 'the counter should have been reset by the successful login');
  }
});

// --- HRD-07: the admin guard does not depend on mount order ------------------
test('HRD-07: every /api/admin/* route refuses a member and an anonymous caller', async () => {
  const w = serialWork.workId;
  const routes: [string, RequestInit][] = [
    [`/api/admin/works/${w}/publish-preview`, {}],
    [`/api/admin/works/${w}/publish`, { method: 'POST', body: '{}' }],
    [`/api/admin/works/${w}/taxonomy`, {}],
    [`/api/admin/works/${w}/taxonomy`, { method: 'PUT', body: JSON.stringify({ categoryIds: [], tagIds: [] }) }],
    [`/api/admin/preview/works/${w}/chapters`, {}],
    [`/api/admin/preview/works/${w}/chapters/${serialWork.chapterId}`, {}],
    ['/api/admin/taxonomy/categories', {}],
    ['/api/admin/taxonomy/categories', { method: 'POST', body: JSON.stringify({ displayName: 'x' }) }],
    [`/api/admin/taxonomy/categories/${tagId}`, { method: 'PATCH', body: JSON.stringify({ isActive: false }) }],
    ['/api/admin/taxonomy/tags', {}],
    ['/api/admin/taxonomy/tags', { method: 'POST', body: JSON.stringify({ displayName: 'x' }) }],
    ['/api/admin/imports', { method: 'POST', body: new FormData() }],
    ['/api/admin/invites', { method: 'POST', body: '{}' }],
  ];
  for (const [path, init] of routes) {
    for (const [who, cookie] of [['member', member], ['anonymous', '']] as const) {
      const res = await app.request(path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      });
      assert.equal(res.status, 403, `${init.method ?? 'GET'} ${path} as ${who} → ${res.status}`);
    }
  }
  // the same routes still work for an admin (the guard is not refusing everyone)
  assert.equal((await GET('/api/admin/taxonomy/categories', admin)).status, 200);
  assert.equal((await GET(`/api/admin/works/${serialWork.workId}/taxonomy`, admin)).status, 200);
});

// --- HRD-08: response headers and body bounds --------------------------------
test('HRD-08: API responses carry restrictive security headers', async () => {
  for (const path of ['/api/works', `/api/reader/works/${serialWork.workId}`, '/api/no/such/route']) {
    const res = await GET(path);
    const h = res.headers;
    assert.equal(h.get('x-content-type-options'), 'nosniff', path);
    assert.equal(h.get('x-frame-options'), 'DENY', path);
    assert.equal(h.get('referrer-policy'), 'no-referrer', path);
    assert.match(h.get('content-security-policy') ?? '', /frame-ancestors 'none'/, path);
    assert.equal(h.get('cache-control'), 'no-store', `${path} member/chapter data must not be cacheable`);
  }
  // HSTS is off by default: pinning https on a plain-HTTP dev host would be a
  // self-inflicted outage
  assert.equal((await GET('/api/works')).headers.get('strict-transport-security'), null);
});

test('HRD-08: an oversized JSON body is refused before it is parsed', async () => {
  const huge = JSON.stringify({ note: 'x'.repeat(2 * 1024 * 1024) });
  const res = await app.request('/api/me/bookmarks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: member },
    body: huge,
  });
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { error: string }).error, 'payload_too_large');

  // the import upload routes keep their own, much larger limit
  const upload = await app.request('/api/admin/imports', {
    method: 'POST', headers: { cookie: admin }, body: new FormData(),
  });
  assert.equal(upload.status, 400, 'uploads are not caught by the JSON body limit');
  assert.equal(((await upload.json()) as { error: string }).error, 'file_required');
});
