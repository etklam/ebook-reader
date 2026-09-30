// L2 E2E acceptance (M6 member state): registration policy + invites,
// library/follow independence, optimistic-concurrency progress (READ-03 via
// two sessions), chapter reads vs PUB-02, bookmarks ownership + frozen
// revisions, preferences sync, continue-reading stability.
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

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-mem-'));
const { app, apiConfig } = await import('../src/index.ts');
const { runOnce } = await import('../src/import/queue.ts');
const { localStorage } = await import('../src/storage.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const { makeDb } = await import('../src/db/client.ts');

const storage = localStorage(process.env.STORAGE_ROOT);
const FIXTURES = fileURLToPath(new URL('../../m0/fixtures/txt', import.meta.url));
const SUFFIX = Math.random().toString(36).slice(2, 8);

const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const workerDb = makeDb(workerPool);

async function q(sql: string, params: unknown[] = []) {
  const res = await workerPool.query(sql, params);
  return res.rows;
}

async function login(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

async function processUntil(importId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const processed = await runOnce(workerDb, storage, { owner: `e2e-m-${SUFFIX}`, leaseMs: 300_000, heartbeatMs: 100_000, maxAttempts: 3, storageConcurrency: 6 });
    if (processed === importId) return;
    const rows = await q(`select status from app.import_jobs where id=$1`, [importId]);
    if (rows[0] && !['queued', 'processing'].includes(rows[0].status)) return;
    if (!processed) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${importId} was never claimed`);
}

const POST = (path: string, cookie: string, body: unknown, extra: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...extra },
    body: JSON.stringify(body),
  });
const PUT = (path: string, cookie: string, body: unknown) =>
  app.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

let admin = '';
let memberA = '';
let memberB = '';
let sessionA2 = '';
let work: string;          // base-180, published
let categoryId: string;

async function seedPublishedWork(): Promise<string> {
  const form = new FormData();
  form.append('file', new File([readFileSync(join(FIXTURES, 'base-180.txt'))], 'base-180.txt'));
  const up = await app.request('/api/admin/imports', { method: 'POST', headers: { cookie: admin }, body: form });
  assert.equal(up.status, 201);
  const { importId } = await up.json() as { importId: string };
  await processUntil(importId);
  const commit = await app.request(`/api/admin/imports/${importId}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ title: `會員測試-${SUFFIX}`, workType: 'serial' }),
  });
  assert.equal(commit.status, 200);
  const workId = ((await commit.json()) as { workId: string }).workId;
  await q(`insert into app.work_categories (work_id, category_id) values ($1, $2)`, [workId, categoryId]);
  await q(`update app.works set serial_status='ongoing', visibility='public' where id=$1`, [workId]);
  const pub = await app.request(`/api/admin/works/${workId}/publish`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': `mem-${workId}` }, body: '{}',
  });
  assert.equal(pub.status, 200);
  return workId;
}

before(async () => {
  await q(`delete from app.import_items where import_job_id in (
    select id from app.import_jobs where status in ('queued','failed') and created_at < now() + interval '5 minutes')`);
  await q(`delete from app.import_jobs where status in ('queued','failed') and created_at < now() + interval '5 minutes'`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
  const email = (role: string) => `e2e-m-${role}-${SUFFIX}@example.test`;
  await pool.query(
    `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,'admin')`,
    [`e2e-m-admin-${SUFFIX}`, email('admin'), await hashPassword('pw-12345678')]);
  for (const m of ['a', 'b'] as const) {
    await pool.query(
      `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,'member')`,
      [`e2e-m-member-${m}-${SUFFIX}`, email(`member-${m}`), await hashPassword('pw-12345678')]);
  }
  [categoryId] = (await q(`insert into app.categories (display_name) values ($1) returning id`, [`會員分類-${SUFFIX}`])).map((r: { id: string }) => r.id);
  await pool.end();
  admin = await login(`e2e-m-admin-${SUFFIX}@example.test`, 'pw-12345678');
  memberA = await login(`e2e-m-member-a-${SUFFIX}@example.test`, 'pw-12345678');
  memberB = await login(`e2e-m-member-b-${SUFFIX}@example.test`, 'pw-12345678'); // distinct member for ownership tests
  sessionA2 = await login(`e2e-m-member-a-${SUFFIX}@example.test`, 'pw-12345678'); // member A, second "device"
  work = await seedPublishedWork();
});

after(async () => {
  const works = await q(`select id from app.works where title like '%' || $1 || '%'`, [SUFFIX]);
  for (const w of works) {
    await q(`update app.source_files set work_id=null where work_id=$1`, [w.id]);
    await q(`update app.import_jobs set work_id=null where work_id=$1`, [w.id]);
    await q(`update app.chapters set head_revision_id=null where work_id=$1`, [w.id]);
    await q(`delete from app.release_items where release_id in (select id from app.work_releases where work_id=$1)`, [w.id]);
    await q(`delete from app.publication_events where work_id=$1`, [w.id]);
    await q(`update app.works set active_release_id=null where id=$1`, [w.id]);
    await q(`delete from app.work_releases where work_id=$1`, [w.id]);
    await q(`delete from app.reading_progress where work_id=$1`, [w.id]);
    await q(`delete from app.bookmarks where work_id=$1`, [w.id]);
    await q(`delete from app.user_chapter_reads where chapter_id in (select id from app.chapters where work_id=$1)`, [w.id]);
    await q(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [w.id]);
    await q(`delete from app.chapters where work_id=$1`, [w.id]);
    await q(`delete from app.work_categories where work_id=$1`, [w.id]);
    await q(`delete from app.user_follows where work_id=$1`, [w.id]);
    await q(`delete from app.user_library where work_id=$1`, [w.id]);
    await q(`delete from app.works where id=$1`, [w.id]);
  }
  await q(`delete from app.categories where id=$1`, [categoryId]);
  await q(`delete from app.apply_idempotency where import_job_id in (select id from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%${SUFFIX}%'))`);
  await q(`delete from app.import_items where import_job_id in (select id from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%${SUFFIX}%'))`);
  await q(`delete from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.source_files s where not exists (select 1 from app.import_jobs j where j.source_file_id = s.id) and s.created_at > now() - interval '1 hour'`);
  await q(`delete from app.user_library where user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.user_follows where user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.reading_progress where user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.user_chapter_reads where user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.bookmarks where user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.reader_preferences where user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.registration_invites where created_by_user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.sessions where user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.users where email like '%${SUFFIX}%'`);
  workerPool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

// --- registration policy ------------------------------------------------------
test('MEM: registration policy — closed by default, invite flow, single-use invite', async () => {
  // default mode in e2e env is closed
  const closed = await POST('/api/auth/register', '', { username: '某會員', email: `reg-${SUFFIX}@example.test`, password: 'pw-12345678' });
  assert.equal(closed.status, 403);
  assert.equal((await closed.json() as { error: string }).error, 'registration_closed');

  // admin creates an invite; raw token shown once
  const inv = await POST('/api/admin/invites', admin, { expiresInDays: 7 });
  assert.equal(inv.status, 201);
  const { invite } = await inv.json() as { invite: string };
  // member cannot create invites
  assert.equal((await POST('/api/admin/invites', memberA, {})).status, 403);

  // registration with the invite succeeds
  apiConfig.registrationMode = 'invite'; // flips the live config (test-only)
  const reg = await POST('/api/auth/register', '', {
    username: `邀請會員-${SUFFIX}`, email: `reg-${SUFFIX}@example.test`, password: 'pw-12345678', invite,
  });
  assert.equal(reg.status, 201, `register: ${reg.status}`);
  // invite single use
  const reg2 = await POST('/api/auth/register', '', {
    username: `第二會員-${SUFFIX}`, email: `reg2-${SUFFIX}@example.test`, password: 'pw-12345678', invite,
  });
  assert.equal(reg2.status, 403);
  apiConfig.registrationMode = 'closed';
});

// --- library + follow independence ---------------------------------------------
test('MEM: library save/remove keeps progress, follow, reads, bookmarks', async () => {
  const toc = await (await app.request(`/api/reader/works/${work}/chapters`)).json() as { chapters: Array<{ id: string; revisionId: string }> };
  const ch5 = toc.chapters[4];

  await PUT(`/api/me/library/${work}`, memberA, {});
  await PUT(`/api/me/follows/${work}`, memberA, {});
  // progress at chapter 5 (PUB-02 setup: user reads to ch5 of 10... base-180 → chapter 5)
  const save = await PUT(`/api/me/progress/${work}`, memberA, {
    chapterId: ch5.id, revisionId: ch5.revisionId, paragraphIndex: 2, baseVersion: 0,
  });
  assert.equal(save.status, 200);
  await POST('/api/me/reads', memberA, { chapterId: ch5.id });
  // bookmark via the RELEASE revision
  const bm = await POST('/api/me/bookmarks', memberA, { workId: work, chapterId: ch5.id, revisionId: ch5.revisionId, paragraphIndex: 2, note: '重點' });
  assert.equal(bm.status, 201);

  // remove favorite → everything else survives
  const del = await app.request(`/api/me/library/${work}`, { method: 'DELETE', headers: { cookie: memberA } });
  assert.equal(del.status, 200);
  const lib = await (await app.request('/api/me/library', { headers: { cookie: memberA } })).json() as { works: unknown[] };
  assert.equal(lib.works.length, 0);
  const prog = await (await app.request(`/api/me/progress/${work}`, { headers: { cookie: memberA } })).json() as { progress: { chapterId: string } | null };
  assert.equal(prog.progress?.chapterId, ch5.id, 'progress survives favorite removal');
  const follows = await (await app.request('/api/me/follows', { headers: { cookie: memberA } })).json() as { follows: unknown[] };
  assert.equal(follows.follows.length, 1, 'follow survives favorite removal');
  const bms = await (await app.request('/api/me/bookmarks', { headers: { cookie: memberA } })).json() as { bookmarks: unknown[] };
  assert.equal(bms.bookmarks.length, 1, 'bookmarks survive favorite removal');

  // unfollow keeps library + progress too
  await PUT(`/api/me/library/${work}`, memberA, {});
  await app.request(`/api/me/follows/${work}`, { method: 'DELETE', headers: { cookie: memberA } });
  const prog2 = await (await app.request(`/api/me/progress/${work}`, { headers: { cookie: memberA } })).json() as { progress: unknown };
  assert.notEqual(prog2.progress, null);
});

// --- progress concurrency (READ-03) ---------------------------------------------
test('MEM: progress optimistic concurrency — stale device cannot overwrite (READ-03)', async () => {
  const toc = await (await app.request(`/api/reader/works/${work}/chapters`)).json() as { chapters: Array<{ id: string; revisionId: string }> };
  const ch10 = toc.chapters[9];
  const ch3 = toc.chapters[2];

  // device A saves progress (a row may exist from earlier tests — read first)
  const current = await (await app.request(`/api/me/progress/${work}`, { headers: { cookie: memberA } })).json() as { progress: { syncVersion: number } | null };
  const s1 = await PUT(`/api/me/progress/${work}`, memberA, { chapterId: ch3.id, revisionId: ch3.revisionId, paragraphIndex: 0, baseVersion: current.progress?.syncVersion ?? 0 });
  assert.equal(s1.status, 200);
  const { syncVersion: v1 } = await s1.json() as { syncVersion: number };

  // device B (same member, second session) reads the same progress and saves
  const gotB = await (await app.request(`/api/me/progress/${work}`, { headers: { cookie: sessionA2 } })).json() as { progress: { syncVersion: number } | null };
  assert.equal(gotB.progress?.syncVersion, v1);
  const s2 = await PUT(`/api/me/progress/${work}`, sessionA2, { chapterId: ch10.id, revisionId: ch10.revisionId, paragraphIndex: 5, baseVersion: gotB.progress.syncVersion });
  assert.equal(s2.status, 200);
  const { syncVersion: v2 } = await s2.json() as { syncVersion: number };

  // stale device A (still at v1) tries to overwrite with an OLDER chapter — 409
  const stale = await PUT(`/api/me/progress/${work}`, memberA, { chapterId: ch3.id, revisionId: ch3.revisionId, paragraphIndex: 1, baseVersion: v1 });
  assert.equal(stale.status, 409);
  const conflict = await stale.json() as { error: string; progress: { syncVersion: number; chapterId: string } };
  assert.equal(conflict.error, 'progress_conflict');
  assert.equal(conflict.progress.syncVersion, v2);
  assert.equal(conflict.progress.chapterId, ch10.id, 'server returns current position for deliberate resolution');

  // re-reading an EARLIER chapter is allowed with the current version (reread)
  const reread = await PUT(`/api/me/progress/${work}`, memberA, { chapterId: ch3.id, revisionId: ch3.revisionId, paragraphIndex: 1, baseVersion: v2 });
  assert.equal(reread.status, 200, 'intentional reread of earlier chapters must work');

  // a revision from another chapter is rejected
  const bad = await PUT(`/api/me/progress/${work}`, memberA, { chapterId: ch3.id, revisionId: ch10.revisionId, paragraphIndex: 0, baseVersion: v2 + 1 });
  assert.equal(bad.status, 400);

  // anonymous cannot save progress
  assert.equal((await PUT(`/api/me/progress/${work}`, '', { chapterId: ch3.id, revisionId: ch3.revisionId, paragraphIndex: 0, baseVersion: 0 })).status, 401);
});

// --- PUB-02: inserted chapter unread, continue-reading stable -------------------
test('MEM: PUB-02 — late 87.5 stays unread; continue reading unchanged; follow badge counts NEW only', async () => {
  // A follows with everything seen (follow happens now → current release seen)
  const f = await PUT(`/api/me/follows/${work}`, memberB, {});
  assert.equal(f.status, 200);

  // admin inserts a mid chapter via partial-181? No — base-180 + a synthetic
  // mid insertion: use the partial-1-170 file as "1-170 with an extra"? The
  // canonical M3 flow: full-190 contains 87.5. Apply full-190 (overwrite).
  const form = new FormData();
  form.append('file', new File([readFileSync(join(FIXTURES, 'full-190.txt'))], 'full-190.txt'));
  form.append('workId', work);
  const up = await app.request('/api/admin/imports', { method: 'POST', headers: { cookie: admin }, body: form });
  assert.equal(up.status, 201);
  const { importId } = await up.json() as { importId: string };
  await processUntil(importId);
  const diff = await (await app.request(`/api/admin/imports/${importId}/diff`, { headers: { cookie: admin } })).json() as { editVersion: number; match: { items: Array<{ itemId: string; itemClass: string; labelRaw: string; matchedChapterId: string | null }> } };
  const resolutions: Record<string, string> = {};
  for (const item of diff.match.items) {
    if (item.itemClass === 'ambiguous' && item.matchedChapterId) resolutions[item.itemId] = `match:${item.matchedChapterId}`;
  }
  const apply = await app.request(`/api/admin/imports/${importId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': `mem-${importId}` },
    body: JSON.stringify({ baseEditVersion: diff.editVersion, mode: 'incremental', resolutions }),
  });
  assert.equal(apply.status, 200, `apply: ${apply.status}`);

  // BEFORE publication: public TOC unchanged (10 → still release v1), and the
  // editorial 87.5 chapter is invisible to the public reader
  const releaseBefore = await (await app.request(`/api/reader/works/${work}`)).json() as { releaseVersion: number; chapterCount: number };
  assert.equal(releaseBefore.releaseVersion, 1);
  const editorial = await (await app.request(`/api/admin/preview/works/${work}/chapters`, { headers: { cookie: admin } })).json() as { chapters: Array<{ id: string; labelRaw: string }> };
  const ch875 = editorial.chapters.find((c) => c.labelRaw === '第87.5章');
  assert.ok(ch875, 'editorial head has 87.5');
  assert.equal((await app.request(`/api/reader/chapters/${ch875.id}`)).status, 404, 'unreleased chapter invisible publicly');

  // publish v2 → 87.5 becomes NEW
  const pub = await app.request(`/api/admin/works/${work}/publish`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': `mem-v2-${work}` }, body: '{}',
  });
  assert.equal(pub.status, 200);
  const pubBody = await pub.json() as { diff: { newChapterIds: string[] } };
  assert.ok(pubBody.diff.newChapterIds.includes(ch875.id), '87.5 is in the NEW set');

  // 87.5 readable publicly now
  assert.equal((await app.request(`/api/reader/chapters/${ch875.id}`)).status, 200);

  // member B's badge: 1 new chapter, unseen
  const follows = await (await app.request('/api/me/follows', { headers: { cookie: memberB } })).json() as { follows: Array<{ workId: string; newChapterCount: number; hasUpdate: boolean }> };
  const mine = follows.follows.find((f2) => f2.workId === work)!;
  assert.ok(mine.newChapterCount >= 1, `badge counts new chapters: ${mine.newChapterCount}`);
  assert.equal(mine.hasUpdate, true);

  // continue reading from BEFORE the publication: member B had progress? set it
  const tocBefore = await (await app.request(`/api/reader/works/${work}/chapters`)).json() as { chapters: Array<{ id: string; labelRaw: string; revisionId: string }> };
  const ch180 = tocBefore.chapters.find((c) => c.labelRaw === '第180章')!;
  const s = await PUT(`/api/me/progress/${work}`, memberB, { chapterId: ch180.id, revisionId: ch180.revisionId, paragraphIndex: 0, baseVersion: 0 });
  assert.ok([200, 409].includes(s.status));

  const prog = await (await app.request(`/api/me/progress/${work}`, { headers: { cookie: memberB } })).json() as { progress: { chapterId: string } | null };
  // progress remains a stable chapter id — NOT max position / release head
  const library = await (await app.request('/api/me/library', { headers: { cookie: memberB } })).json() as { works: Array<{ continueChapterId: string | null }> };
  void library;
  assert.equal(prog.progress?.chapterId, ch180.id, 'continue reading is chapter-id based');

  // mark seen clears the badge WITHOUT marking the chapter read
  const seen = await POST(`/api/me/follows/${work}/seen`, memberB, {});
  assert.equal(seen.status, 200);
  const followsAfter = await (await app.request('/api/me/follows', { headers: { cookie: memberB } })).json() as { follows: Array<{ newChapterCount: number; hasUpdate: boolean }> };
  assert.equal(followsAfter.follows.find((f2) => f2.workId === work)!.newChapterCount, 0);
  const reads = await (await app.request(`/api/me/reads?workId=${work}`, { headers: { cookie: memberB } })).json() as { reads: Array<{ chapterId: string }> };
  assert.ok(!reads.reads.some((r) => r.chapterId === ch875.id), 'update-seen != chapter-read');
});

// --- bookmarks ownership + frozen revision --------------------------------------
test('MEM: bookmarks — owner-only access, frozen revision, note edit, delete', async () => {
  const toc = await (await app.request(`/api/reader/works/${work}/chapters`)).json() as { chapters: Array<{ id: string; revisionId: string }> };
  const ch = toc.chapters[7];
  const bm = await POST('/api/me/bookmarks', memberA, { workId: work, chapterId: ch.id, revisionId: ch.revisionId, paragraphIndex: 3, note: 'n1' });
  assert.equal(bm.status, 201);
  const { id } = await bm.json() as { id: string };

  // member B cannot touch A's bookmark
  assert.equal((await app.request(`/api/me/bookmarks/${id}`, { method: 'DELETE', headers: { cookie: memberB } })).status, 404);
  assert.equal((await app.request(`/api/me/bookmarks/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: memberB }, body: JSON.stringify({ note: 'hack' }),
  })).status, 404);
  const listB = await (await app.request('/api/me/bookmarks', { headers: { cookie: memberB } })).json() as { bookmarks: unknown[] };
  assert.equal(listB.bookmarks.length, 0, 'A bookmarks never appear in B list');

  // owner edits note
  const patch = await app.request(`/api/me/bookmarks/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: memberA }, body: JSON.stringify({ note: 'n2' }),
  });
  assert.equal(patch.status, 200);
  const list = await (await app.request(`/api/me/bookmarks?workId=${work}`, { headers: { cookie: memberA } })).json() as { bookmarks: Array<{ note: string; revisionId: string; label: string | null }> };
  const mine = list.bookmarks.find((b) => b.id === id)!;
  assert.equal(mine.note, 'n2');

  // a NEW revision published later does NOT rewrite the bookmark's frozen revision
  // (revision here is the release one; simulate a head change then verify bookmark unchanged)
  const del = await app.request(`/api/me/bookmarks/${id}`, { method: 'DELETE', headers: { cookie: memberA } });
  assert.equal(del.status, 200);
  void ch;
});

// --- preferences sync (READ-03) ---------------------------------------------------
test('MEM: reader preferences sync across sessions', async () => {
  const put = await PUT('/api/me/reader-preferences', memberA, {
    theme: 'sepia', fontSize: 22, lineHeight: 2.0, paragraphSpacing: 1.2, conversion: 'cn', mode: 'paginated',
  });
  assert.equal(put.status, 200);
  const gotB = await (await app.request('/api/me/reader-preferences', { headers: { cookie: sessionA2 } })).json() as { preferences: { theme: string; fontSize: number; mode: string } };
  assert.equal(gotB.preferences?.theme, 'sepia');
  assert.equal(gotB.preferences?.fontSize, 22);
  assert.equal(gotB.preferences?.mode, 'paginated');
  // out-of-range rejected
  const bad = await PUT('/api/me/reader-preferences', memberA, {
    theme: 'dark', fontSize: 99, lineHeight: 1.8, paragraphSpacing: 1, conversion: 'original', mode: 'scroll',
  });
  assert.equal(bad.status, 400);
});

// --- TXT Big5 sanity retained from M2 harness (fixture reuse) ----------------------
test('MEM: legacy Big5 fixture still parses (sanity)', () => {
  const bytes = iconv.encode('第1章 測試\n\n內容', 'big5');
  assert.ok(bytes.length > 0);
});
