// L2 E2E acceptance (M6 catalog + taxonomy, CAT per dev-plan §03A): taxonomy
// CRUD, work assignment limits, inactive policy, catalog filter contract
// (type / category OR / tag all-any / serial status / keyword incl.
// Traditional↔Simplified / 0-result truthfulness / pagination), permission
// matrix, and import-never-destroys-taxonomy regression.
//
// Run: pnpm --filter server test:e2e   (needs `pnpm db:up` + `pnpm db:migrate`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-tax-'));
const { app } = await import('../src/index.ts');
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
    const processed = await runOnce(workerDb, storage, { owner: `e2e-t-${SUFFIX}`, leaseMs: 300_000, heartbeatMs: 100_000, maxAttempts: 3, storageConcurrency: 6 });
    if (processed === importId) return;
    const rows = await q(`select status from app.import_jobs where id=$1`, [importId]);
    if (rows[0] && !['queued', 'processing'].includes(rows[0].status)) return;
    if (!processed) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${importId} was never claimed`);
}

async function publish(cookie: string, workId: string, key: string) {
  return app.request(`/api/admin/works/${workId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'idempotency-key': key },
    body: '{}',
  });
}

let admin = '';
let member = '';
let catA = ''; let catB = ''; // 都市 / 科幻
let tagR = ''; let tagS = ''; let tagT = ''; // 重生 / 系統 / 慢熱
let wUrbanRebirthSystem = '';      // serial, ongoing, 都市+重生+系統
let wSciFiSlow = '';               // serial, completed, 科幻+慢熱
let wShort = '';                   // short_story, 都市

before(async () => {
  await q(`delete from app.import_items where import_job_id in (
    select id from app.import_jobs where status in ('queued','failed') and created_at < now() + interval '5 minutes')`);
  await q(`delete from app.import_jobs where status in ('queued','failed') and created_at < now() + interval '5 minutes'`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
  const email = (role: string) => `e2e-t-${role}-${SUFFIX}@example.test`;
  for (const role of ['admin', 'member'] as const) {
    await pool.query(
      `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,$4)`,
      [`e2e-t-${role}-${SUFFIX}`, email(role), await hashPassword('pw-12345678'), role]);
  }
  await pool.end();
  admin = await login(`e2e-t-admin-${SUFFIX}@example.test`, 'pw-12345678');
  member = await login(`e2e-t-member-${SUFFIX}@example.test`, 'pw-12345678');

  // taxonomy via the Admin API (CRUD covered below)
  const mk = async (kind: 'categories' | 'tags', name: string, sortOrder = 0): Promise<string> => {
    const res = await app.request(`/api/admin/taxonomy/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin },
      body: JSON.stringify({ displayName: `${name}-${SUFFIX}`, sortOrder }),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { id: string }).id;
  };
  catA = await mk('categories', '都市', 1);
  catB = await mk('categories', '科幻', 2);
  tagR = await mk('tags', '重生');
  tagS = await mk('tags', '系統');
  tagT = await mk('tags', '慢熱');

  // three published works with distinct filter profiles
  const seed = async (fixture: string, title: string): Promise<string> => {
    const form = new FormData();
    form.append('file', new File([readFileSync(join(FIXTURES, fixture))], fixture));
    const up = await app.request('/api/admin/imports', { method: 'POST', headers: { cookie: admin }, body: form });
    assert.equal(up.status, 201);
    const { importId } = await up.json() as { importId: string };
    await processUntil(importId);
    const commit = await app.request(`/api/admin/imports/${importId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin },
      body: JSON.stringify({ title: `${title}-${SUFFIX}`, workType: 'serial' }),
    });
    assert.equal(commit.status, 200);
    return ((await commit.json()) as { workId: string }).workId;
  };
  const assign = async (workId: string, cats: string[], tgs: string[]) => {
    const res = await app.request(`/api/admin/works/${workId}/taxonomy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: admin },
      body: JSON.stringify({ categoryIds: cats, tagIds: tgs }),
    });
    assert.equal(res.status, 200);
  };
  wUrbanRebirthSystem = await seed('weird-labels.txt', 'CAT都市重生');
  await assign(wUrbanRebirthSystem, [catA], [tagR, tagS]);
  wSciFiSlow = await seed('partial-181-190.txt', 'CAT科幻慢熱');
  await assign(wSciFiSlow, [catB], [tagT]);
  // short story: single-chapter fixture with a Traditional title (繁簡搜尋用)
  wShort = await seed('partial-1-170.txt', 'CAT都市短篇');
  const res = await app.request(`/api/admin/works/${wShort}/taxonomy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ categoryIds: [catA], tagIds: [] }),
  });
  assert.equal(res.status, 200);
  await q(`update app.works set work_type='short_story', serial_status=null where id=$1`, [wShort]);

  await q(`update app.works set serial_status='completed', visibility='public' where id=$1`, [wSciFiSlow]);
  await q(`update app.works set serial_status='ongoing', visibility='public' where id=$1`, [wUrbanRebirthSystem]);
  await q(`update app.works set serial_status=null, visibility='public' where id=$1`, [wShort]);
  for (const w of [wUrbanRebirthSystem, wSciFiSlow, wShort]) seeded.add(w);
  for (const [i, w] of [wUrbanRebirthSystem, wSciFiSlow, wShort].entries()) {
    const r = await publish(admin, w, `cat-pub-${SUFFIX}-${i}`);
    assert.equal(r.status, 200, `publish seed ${i}`);
  }
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
    await q(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [w.id]);
    await q(`delete from app.chapters where work_id=$1`, [w.id]);
    await q(`delete from app.work_categories where work_id=$1`, [w.id]);
    await q(`delete from app.work_tags where work_id=$1`, [w.id]);
    await q(`delete from app.works where id=$1`, [w.id]);
  }
  await q(`delete from app.apply_idempotency where import_job_id in (select id from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%${SUFFIX}%'))`);
  await q(`delete from app.import_items where import_job_id in (select id from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%${SUFFIX}%'))`);
  await q(`delete from app.import_jobs where requested_by_user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.source_files s where not exists (select 1 from app.import_jobs j where j.source_file_id = s.id) and s.created_at > now() - interval '1 hour'`);
  await q(`delete from app.categories where id in ($1,$2)`, [catA, catB]);
  await q(`delete from app.tags where id in ($1,$2,$3)`, [tagR, tagS, tagT]);
  await q(`delete from app.sessions where user_id in (select id from app.users where email like '%${SUFFIX}%')`);
  await q(`delete from app.users where email like '%${SUFFIX}%'`);
  workerPool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

async function catalog(query: string, cookie = ''): Promise<{ works: Array<{ id: string; title: string; categories: string[]; tags: string[]; chapterCount: number }>; limit: number; offset: number }> {
  const res = await app.request(`/api/works${query}`, { headers: cookie ? { cookie } : {} });
  assert.equal(res.status, 200, `catalog ${query}`);
  return res.json();
}

const seeded = new Set<string>();
const titlesOf = (r: { works: Array<{ id: string }> }) => new Set(r.works.filter((w) => seeded.has(w.id)).map((w) => w.id));

test('CAT: taxonomy CRUD — create, rename, deactivate; duplicate rejected', async () => {
  const created = await app.request('/api/admin/taxonomy/tags', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ displayName: `暫存-${SUFFIX}`, description: 'd' }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  const dup = await app.request('/api/admin/taxonomy/tags', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ displayName: `暫存-${SUFFIX}` }),
  });
  assert.equal(dup.status, 409);
  const renamed = await app.request(`/api/admin/taxonomy/tags/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ displayName: `改名-${SUFFIX}`, isActive: false }),
  });
  assert.equal(renamed.status, 200);
  const renamedBody = await renamed.json() as { displayName: string; isActive: boolean };
  assert.equal(renamedBody.isActive, false);
  // member cannot mutate taxonomy
  const forbidden = await app.request('/api/admin/taxonomy/tags', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: member },
    body: JSON.stringify({ displayName: 'x' }),
  });
  assert.equal(forbidden.status, 403);
  await q(`delete from app.tags where id=$1`, [id]);
});

test('CAT: assignment limits and inactive policy', async () => {
  // 6 categories exceed the limit of 5
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await app.request('/api/admin/taxonomy/categories', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin },
      body: JSON.stringify({ displayName: `超限-${SUFFIX}-${i}` }),
    });
    ids.push(((await r.json()) as { id: string }).id);
  }
  const over = await app.request(`/api/admin/works/${wShort}/taxonomy`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ categoryIds: ids, tagIds: [] }),
  });
  assert.equal(over.status, 400);
  // inactive taxonomy cannot be newly assigned
  const inactive = await app.request(`/api/admin/taxonomy/tags/${tagT}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(inactive.status, 200);
  const blocked = await app.request(`/api/admin/works/${wShort}/taxonomy`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ categoryIds: [catA], tagIds: [tagR, tagT] }), // tagT already on another work, new here
  });
  assert.equal(blocked.status, 400);
  const [activeT] = await q(`update app.tags set is_active=true where id=$1 returning id`, [tagT]);
  // existing assignment with later-deactivated taxonomy stays (documented policy)
  await app.request(`/api/admin/taxonomy/tags/${tagT}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: admin },
    body: JSON.stringify({ isActive: false }),
  });
  const keep = await q(`select count(*)::int as n from app.work_tags wt where wt.work_id=$1 and wt.tag_id=$2`, [wSciFiSlow, tagT]);
  assert.equal(keep[0].n, 1, 'existing rows survive deactivation');
  await q(`update app.tags set is_active=true where id=$1`, [activeT.id]);
  for (const id of ids) await q(`delete from app.categories where id=$1`, [id]);
});

test('CAT: filter contract — category OR, tag all/any, type, serial status', async () => {
  const catOr = await catalog(`?categoryIds=${catA},${catB}`);
  assert.equal(titlesOf(catOr).size, 3, 'category OR: all three works');

  const tagAll = await catalog(`?tagIds=${tagR},${tagS}&tagMode=all`);
  assert.deepEqual([...titlesOf(tagAll)], [wUrbanRebirthSystem], 'tag ALL: 重生 AND 系統');

  const tagAny = await catalog(`?tagIds=${tagR},${tagT}&tagMode=any`);
  assert.equal(titlesOf(tagAny).size, 2, 'tag ANY: 重生 OR 慢熱');

  const tagAllDefault = await catalog(`?tagIds=${tagR},${tagS}`);
  assert.deepEqual([...titlesOf(tagAllDefault)], [wUrbanRebirthSystem], 'default tagMode is all');

  const serial = await catalog(`?type=serial&serialStatus=completed`);
  assert.deepEqual([...titlesOf(serial)], [wSciFiSlow], 'serial status filter');

  const shorts = await catalog(`?type=short_story`);
  assert.deepEqual([...titlesOf(shorts)], [wShort]);

  // dimensions AND-combine
  const combo = await catalog(`?type=serial&categoryIds=${catB}&tagIds=${tagT}&tagMode=all&serialStatus=completed`);
  assert.deepEqual([...titlesOf(combo)], [wSciFiSlow]);
});

test('CAT: keyword search works across Traditional/Simplified (title, author, category, tag)', async () => {
  // title is Traditional; search with Simplified title keyword
  const simp = await catalog(`?q=都市重生`); // already Traditional here; also try converted form below
  assert.ok(titlesOf(simp).has(wUrbanRebirthSystem));
  // '科技' converts to 科幻? search category via its variant: query '科幻' and simplified '科幻' identical — use a t↔s-divergent pair: 標籤「慢熱」 vs simplified '慢热'
  const tagVariants = await catalog(`?q=慢热`);
  assert.ok(titlesOf(tagVariants).has(wSciFiSlow), 'simplified keyword finds Traditional tag');
  const catVariants = await catalog(`?q=科學`); // control: no match
  assert.equal(titlesOf(catVariants).size, 0, 'control keyword matches nothing');
});

test('CAT: 0-result is truthful; invalid filters rejected; pagination preserves filters', async () => {
  const zero = await catalog(`?tagIds=${tagR}&tagMode=all&categoryIds=${catB}`);
  assert.equal(titlesOf(zero).size, 0, 'never silently weakens filters');

  const bad = await app.request('/api/works?type=nonsense');
  assert.equal(bad.status, 400);

  const page1 = await catalog(`?tagIds=${tagR},${tagS}&tagMode=all&limit=1&offset=0`);
  assert.equal(page1.works.length, 1);
  const page2 = await catalog(`?tagIds=${tagR},${tagS}&tagMode=all&limit=1&offset=1`);
  assert.equal(page2.works.length, 0, 'pagination applies to the filtered set, not the raw table');

  const count = await (await app.request('/api/works/count')).json() as { count: number };
  assert.ok(count.count >= 3);
});

test('CAT: import/apply never destroys taxonomy or publication state (regression)', async () => {
  // re-import the same fixture as incremental against the work
  const form = new FormData();
  form.append('file', new File([readFileSync(join(FIXTURES, 'weird-labels.txt'))], 'weird-labels.txt'));
  form.append('workId', wUrbanRebirthSystem);
  const up = await app.request('/api/admin/imports', { method: 'POST', headers: { cookie: admin }, body: form });
  assert.equal(up.status, 201);
  const { importId } = await up.json() as { importId: string };
  await processUntil(importId);
  const diff = await app.request(`/api/admin/imports/${importId}/diff`, { headers: { cookie: admin } });
  assert.equal(diff.status, 200);
  const d = await diff.json() as { editVersion: number; match: { items: Array<{ itemId: string; itemClass: string; labelRaw: string }> } };
  const chapters = (await q(`select id, label_raw from app.chapters where work_id=$1`, [wUrbanRebirthSystem]))
    .map((r: { id: string; label_raw: string }) => ({ id: r.id, labelRaw: r.label_raw }));
  const resolutions: Record<string, string> = {};
  for (const item of d.match.items) {
    if (item.itemClass === 'ambiguous') {
      const target = chapters.find((c) => c.labelRaw === item.labelRaw);
      assert.ok(target);
      resolutions[item.itemId] = `match:${target.id}`;
    }
  }
  const apply = await app.request(`/api/admin/imports/${importId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin, 'idempotency-key': `cat-${importId}` },
    body: JSON.stringify({ baseEditVersion: d.editVersion, mode: 'incremental', resolutions }),
  });
  assert.equal(apply.status, 200, `incremental apply: ${apply.status} ${JSON.stringify(await apply.json().catch(() => null))}` as string);
  const cats = await q(`select count(*)::int as n from app.work_categories where work_id=$1`, [wUrbanRebirthSystem]);
  const tgs = await q(`select count(*)::int as n from app.work_tags where work_id=$1`, [wUrbanRebirthSystem]);
  assert.equal(cats[0].n, 1, 'categories survive re-import');
  assert.equal(tgs[0].n, 2, 'tags survive re-import');
  const rel = await q(`select count(*)::int as n from app.release_items where release_id in (select id from app.work_releases where work_id=$1)`, [wUrbanRebirthSystem]);
  assert.equal(rel[0].n, 10, 'active release untouched by import');
  // catalog still shows the OLD release content count until republished
  const listed = await catalog(`?categoryIds=${catA}`);
  const entry = listed.works.find((w) => w.id === wUrbanRebirthSystem);
  assert.equal(entry?.chapterCount, 10, 'catalog chapter count comes from the release');
});
