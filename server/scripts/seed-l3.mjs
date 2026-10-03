// Seed the three published works the M5 L3 real-device checklist needs.
//
//   pnpm seed:l3            (needs db:up + db:migrate; does NOT need dev:api)
//
// Goes through the real pipeline — upload → worker parse → commit → publish —
// so the fixture a device sees is produced the same way real content is, and
// seeding doubles as another exercise of the ingestion path. Re-running is
// safe: existing L3 works are republished rather than duplicated.
//
// Covers every checklist item:
//   L3-連載     180 chapters → open, prev/next, TOC jump, re-anchor, modes,
//               themes, font sizes, safe-area, reload consistency (items 1-16, 18)
//   L3-長章     one ~200k-char chapter → scroll/no-crash on a long body (item 17)
//   L3-不規則   12.5 / 12.10 / 上下篇 / 番外 / 無數字 labels → TOC with
//               irregular labels rendered verbatim (item 2)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const FIXTURES = fileURLToPath(new URL('../../m0/fixtures/txt', import.meta.url));
const ADMIN_EMAIL = process.env.L3_ADMIN_EMAIL ?? 'l3-seed@example.test';
const ADMIN_PASSWORD = process.env.L3_ADMIN_PASSWORD ?? 'l3-seed-password';

// the API is imported in-process: no dev:api required, and the storage root
// must match whatever the running dev server will later read from
process.env.STORAGE_ROOT ??= './storage';

const { app } = await import('../src/index.ts');
const { runOnce } = await import('../src/import/queue.ts');
const { localStorage } = await import('../src/storage.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const { makeDb } = await import('../src/db/client.ts');

const storage = localStorage(process.env.STORAGE_ROOT);
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 2 });
const workerDb = makeDb(pool);
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const WORKS = [
  {
    key: 'serial',
    fixture: 'base-180.txt',
    title: 'L3 真機樣本｜連載',
    workType: 'serial',
    serialStatus: 'ongoing',
    note: '180 章：開書、上下章、目錄跳章、回錨、模式、主題、字號、safe-area',
  },
  {
    key: 'long',
    fixture: 'long-one-chapter.txt',
    title: 'L3 真機樣本｜長章',
    workType: 'short_story',
    serialStatus: null,
    note: '單一長章（~20 萬字）：捲動不卡頓、不崩潰（第 17 項）',
  },
  {
    key: 'weird',
    fixture: 'weird-labels.txt',
    title: 'L3 真機樣本｜不規則章號',
    workType: 'serial',
    serialStatus: 'completed',
    note: '12.5／12.10／上下篇／番外／無數字：目錄逐字保留（第 2 項）',
  },
];

async function ensureAdmin() {
  const [existing] = await q(`select id from app.users where email = $1`, [ADMIN_EMAIL]);
  if (existing) {
    // reset the password so the printed credentials always work
    await q(`update app.users set password_hash = $2, role = 'admin' where id = $1`,
      [existing.id, await hashPassword(ADMIN_PASSWORD)]);
    return existing.id;
  }
  const [row] = await q(
    `insert into app.users (username, email, password_hash, role)
     values ('l3-seed', $1, $2, 'admin') returning id`,
    [ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD)]);
  return row.id;
}

async function login() {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`seed admin login failed: ${res.status}`);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

// drain the queue in-process rather than requiring a separate worker
async function processUntil(importId) {
  for (let i = 0; i < 200; i++) {
    const processed = await runOnce(workerDb, storage, {
      owner: 'seed-l3', leaseMs: 300_000, heartbeatMs: 100_000, maxAttempts: 3, storageConcurrency: 6,
    });
    if (processed === importId) return;
    const [job] = await q(`select status from app.import_jobs where id = $1`, [importId]);
    if (job && !['queued', 'processing'].includes(job.status)) return;
    if (!processed) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`import ${importId} was never processed`);
}

async function seed(cookie, spec, categoryId) {
  const title = spec.title;
  const [found] = await q(`select id from app.works where title = $1`, [title]);
  let workId = found?.id;

  if (!workId) {
    const bytes = await readFile(join(FIXTURES, spec.fixture));
    const form = new FormData();
    form.append('file', new File([bytes], spec.fixture));
    const up = await app.request('/api/admin/imports', { method: 'POST', headers: { cookie }, body: form });
    if (up.status !== 201) throw new Error(`upload ${spec.fixture} → ${up.status} ${await up.text()}`);
    const { importId } = await up.json();
    await processUntil(importId);
    const [job] = await q(`select status, error_code, error_detail from app.import_jobs where id = $1`, [importId]);
    // commit accepts ready | review_required (import/commit.ts); anything else
    // means parsing failed and publishing a half-parsed work would be worse
    // than stopping here
    if (!['ready', 'review_required'].includes(job.status)) {
      throw new Error(`import ${spec.fixture} ended as ${job.status} ${job.error_code ?? ''} ${job.error_detail ?? ''}`);
    }
    const commit = await app.request(`/api/admin/imports/${importId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title, workType: spec.workType }),
    });
    if (commit.status !== 200) throw new Error(`commit ${spec.fixture} → ${commit.status} ${await commit.text()}`);
    workId = (await commit.json()).workId;
  }

  // publish validation requires a category on first publish, and public
  // visibility is what makes the work reachable from the catalog
  await q(`update app.works set serial_status = $2, visibility = 'public' where id = $1`,
    [workId, spec.serialStatus]);
  await q(`insert into app.work_categories (work_id, category_id) values ($1, $2)
           on conflict do nothing`, [workId, categoryId]);

  const [release] = await q(`select active_release_id from app.works where id = $1`, [workId]);
  if (!release.active_release_id) {
    const pub = await app.request(`/api/admin/works/${workId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': `l3-seed-${workId}` },
      body: JSON.stringify({ note: 'L3 real-device seed' }),
    });
    if (pub.status !== 200) throw new Error(`publish ${title} → ${pub.status} ${await pub.text()}`);
  }

  const [counts] = await q(
    `select r.chapter_count from app.work_releases r
     join app.works w on w.active_release_id = r.id where w.id = $1`, [workId]);
  const [first] = await q(
    `select ri.chapter_id from app.release_items ri
     join app.works w on w.active_release_id = ri.release_id
     where w.id = $1 order by ri.editorial_position asc limit 1`, [workId]);
  return { workId, chapterCount: counts.chapter_count, firstChapterId: first.chapter_id, ...spec };
}

// Remove the seeded works and their content. Deliberately scoped to the three
// seeded titles — it never touches anything else, so running it against a
// database that also holds real content is safe.
async function clean() {
  const titles = WORKS.map((w) => w.title);
  const works = await q(`select id from app.works where title = any($1)`, [titles]);
  for (const { id } of works) {
    await q(`update app.works set active_release_id = null where id = $1`, [id]);
    await q(`delete from app.publication_events where work_id = $1`, [id]);
    await q(`delete from app.release_items where release_id in
             (select id from app.work_releases where work_id = $1)`, [id]);
    await q(`delete from app.work_releases where work_id = $1`, [id]);
    await q(`delete from app.bookmarks where work_id = $1`, [id]);
    await q(`delete from app.reading_progress where work_id = $1`, [id]);
    await q(`delete from app.user_chapter_reads where chapter_id in
             (select id from app.chapters where work_id = $1)`, [id]);
    await q(`delete from app.user_follows where work_id = $1`, [id]);
    await q(`delete from app.user_library where work_id = $1`, [id]);
    await q(`delete from app.work_categories where work_id = $1`, [id]);
    await q(`delete from app.work_tags where work_id = $1`, [id]);
    await q(`update app.chapters set head_revision_id = null where work_id = $1`, [id]);
    await q(`delete from app.chapter_revisions where chapter_id in
             (select id from app.chapters where work_id = $1)`, [id]);
    await q(`delete from app.chapters where work_id = $1`, [id]);
    await q(`delete from app.volumes where work_id = $1`, [id]);
    // import chain, innermost FK first: apply_idempotency → import_items →
    // import_jobs → source_files (jobs reference source_files, which
    // references works, so works must come last)
    const jobScope = `(select id from app.import_jobs where work_id = $1 or committed_work_id = $1)`;
    await q(`delete from app.apply_idempotency where import_job_id in ${jobScope}`, [id]);
    await q(`delete from app.import_items where import_job_id in ${jobScope}`, [id]);
    await q(`delete from app.import_jobs where work_id = $1 or committed_work_id = $1`, [id]);
    await q(`delete from app.source_files where work_id = $1`, [id]);
    await q(`delete from app.works where id = $1`, [id]);
    console.log(`removed ${id}`);
  }
  await q(`delete from app.sessions where user_id in (select id from app.users where email = $1)`, [ADMIN_EMAIL]);
  await q(`delete from app.users where email = $1`, [ADMIN_EMAIL]);
  await q(`delete from app.categories where display_name = 'L3 真機測試'`);
  console.log(`cleaned ${works.length} seeded work(s). Storage objects are left for the M7 GC.`);
}

try {
  if (process.argv.includes('--clean')) {
    await clean();
    process.exit(0);
  }
  await ensureAdmin();
  const cookie = await login();

  const CATEGORY = 'L3 真機測試';
  let [cat] = await q(`select id from app.categories where display_name = $1`, [CATEGORY]);
  if (!cat) {
    [cat] = await q(`insert into app.categories (display_name, description)
                     values ($1, '真機驗證用樣本，Beta 前移除') returning id`, [CATEGORY]);
  }

  const results = [];
  for (const spec of WORKS) {
    process.stderr.write(`seeding ${spec.title} … `);
    results.push(await seed(cookie, spec, cat.id));
    process.stderr.write('ok\n');
  }

  const host = process.env.L3_HOST ?? 'http://<your-lan-ip>:5173';
  console.log('\n=== M5 L3 真機樣本已就緒 ===\n');
  console.log(`Admin 帳號：${ADMIN_EMAIL} / ${ADMIN_PASSWORD}  （僅本機測試用）\n`);
  for (const r of results) {
    console.log(`${r.title}  —  ${r.chapterCount} 章`);
    console.log(`  ${r.note}`);
    console.log(`  作品頁：${host}/works/${r.workId}`);
    console.log(`  首章  ：${host}/read/${r.workId}/${r.firstChapterId}\n`);
  }
  console.log(`書庫：${host}/`);
  console.log('\n清理：pnpm seed:l3 --clean\n');
} finally {
  await pool.end();
}
