// Representative-volume seed for query measurement (M7 Phase 3.4 / CAT-T5,
// DB-T4).
//
//   pnpm --filter server perf:seed            # ~5k works, ~50k chapters
//   pnpm --filter server perf:seed --works=20000
//   pnpm --filter server perf:seed --clean
//
// Metadata only, built with set-based SQL rather than the import pipeline:
// what we are measuring is catalog/filter query planning, and parsing 50k
// chapters of prose would take orders of magnitude longer while changing
// nothing about the plans.
//
// IMPORTANT: seeded chapters reference content keys that have no storage
// objects. That is fine for query measurement, but it means `pnpm maintenance`
// will report seeded published chapters under the missing-object integrity
// check. Run `--clean` before trusting that report.
import { Pool } from 'pg';

const args = process.argv.slice(2);
const clean = args.includes('--clean');
const WORKS = Number(args.find((a) => a.startsWith('--works='))?.split('=')[1] ?? 5000);
const CHAPTERS_PER_WORK = Number(args.find((a) => a.startsWith('--chapters='))?.split('=')[1] ?? 10);
const MARK = 'perfseed';

const pool = new Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL, max: 1 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

async function doClean() {
  console.log('cleaning perf seed data …');
  // order matters: innermost references first
  await q(`delete from app.release_items where release_id in
           (select r.id from app.work_releases r join app.works w on w.id = r.work_id
            where w.title like $1)`, [`${MARK}%`]);
  await q(`update app.works set active_release_id = null where title like $1`, [`${MARK}%`]);
  await q(`delete from app.publication_events where work_id in
           (select id from app.works where title like $1)`, [`${MARK}%`]);
  await q(`delete from app.work_releases where work_id in
           (select id from app.works where title like $1)`, [`${MARK}%`]);
  await q(`delete from app.work_categories where work_id in
           (select id from app.works where title like $1)`, [`${MARK}%`]);
  await q(`delete from app.work_tags where work_id in
           (select id from app.works where title like $1)`, [`${MARK}%`]);
  await q(`update app.chapters set head_revision_id = null where work_id in
           (select id from app.works where title like $1)`, [`${MARK}%`]);
  await q(`delete from app.chapter_revisions where chapter_id in
           (select c.id from app.chapters c join app.works w on w.id = c.work_id
            where w.title like $1)`, [`${MARK}%`]);
  await q(`delete from app.chapters where work_id in
           (select id from app.works where title like $1)`, [`${MARK}%`]);
  await q(`delete from app.works where title like $1`, [`${MARK}%`]);
  await q(`delete from app.categories where display_name like $1`, [`${MARK}%`]);
  await q(`delete from app.tags where display_name like $1`, [`${MARK}%`]);
  console.log('clean done');
}

async function seed() {
  const t0 = Date.now();
  // an admin to own the releases
  const [admin] = await q(
    `insert into app.users (username, email, password_hash, role)
     values ($1, $2, 'scrypt$1$1$1$x$x', 'admin')
     on conflict (email) do update set role = 'admin' returning id`,
    [`${MARK}-owner`, `${MARK}-owner@example.test`]);

  console.log(`seeding ${WORKS} works × ${CHAPTERS_PER_WORK} chapters …`);

  // taxonomy: 30 categories, 200 tags — the vocabulary sizes §03A anticipates
  await q(`insert into app.categories (display_name, sort_order)
           select $1 || '-分類-' || i, i from generate_series(1, 30) i
           on conflict do nothing`, [MARK]);
  await q(`insert into app.tags (display_name)
           select $1 || '-標籤-' || i from generate_series(1, 200) i
           on conflict do nothing`, [MARK]);

  // Chinese titles/authors so ILIKE behaves as it will in production; a mix of
  // types and statuses so every filter dimension is selective
  await q(`
    insert into app.works (title, author, work_type, serial_status, description, visibility)
    select
      $1 || '-作品-' || i || '-' ||
        (array['風起','霧中燈','長夜','潮汐','殘響','破曉','舊鑰匙','折返點'])[1 + (i % 8)],
      $1 || '-作者-' || (i % 500),
      case when i % 5 = 0 then 'short_story' else 'serial' end,
      case when i % 5 = 0 then null
           when i % 3 = 0 then 'completed'
           when i % 7 = 0 then 'paused'
           else 'ongoing' end,
      '合成描述，僅供效能量測使用。',
      case when i % 20 = 0 then 'draft' else 'public' end
    from generate_series(1, $2) i`, [MARK, WORKS]);

  // 1–5 categories and 2–20 tags per work. The pick index must be derived from
  // the work and a counter, NOT from the taxonomy row number — a condition
  // like `c.rn = f(w.rn, c.rn)` only matches by coincidence and produced ~0.05
  // assignments per work instead of ~3, which would have made every multi-tag
  // measurement meaningless.
  await q(`
    insert into app.work_categories (work_id, category_id)
    select w.id, c.id
    from (select id, row_number() over (order by title) rn from app.works where title like $1) w
    cross join generate_series(1, 5) k
    join (select id, row_number() over (order by display_name) rn
          from app.categories where display_name like $1) c
      on c.rn = 1 + ((w.rn * 7 + k * 11) % 30)
    where k <= 1 + (w.rn % 5)
    on conflict do nothing`, [`${MARK}%`]);
  await q(`
    insert into app.work_tags (work_id, tag_id)
    select w.id, t.id
    from (select id, row_number() over (order by title) rn from app.works where title like $1) w
    cross join generate_series(1, 20) k
    join (select id, row_number() over (order by display_name) rn
          from app.tags where display_name like $1) t
      on t.rn = 1 + ((w.rn * 13 + k * 29) % 200)
    where k <= 2 + (w.rn % 19)
    on conflict do nothing`, [`${MARK}%`]);

  await q(`
    insert into app.chapters (work_id, label_raw, editorial_position)
    select w.id, '第' || p || '章', p
    from app.works w, generate_series(1, $2) p
    where w.title like $1`, [`${MARK}%`, CHAPTERS_PER_WORK]);

  await q(`
    insert into app.chapter_revisions
      (chapter_id, title, content_key, body_compare_hash, revision_hash, processor_version)
    select c.id,
           '第' || c.editorial_position || '章',
           substr(md5(c.id::text), 1, 2) || '/' || gen_random_uuid() || '.txt',
           md5(c.id::text), md5(c.id::text || 'r'), 'perfseed'
    from app.chapters c join app.works w on w.id = c.work_id
    where w.title like $1`, [`${MARK}%`]);

  await q(`
    update app.chapters c set head_revision_id = r.id
    from app.chapter_revisions r
    where r.chapter_id = c.id and c.head_revision_id is null
      and c.work_id in (select id from app.works where title like $1)`, [`${MARK}%`]);

  // one release per public work, published across a 2-year window so the
  // `updated` sort and its keyset pagination have realistic spread
  await q(`
    insert into app.work_releases (work_id, version, chapter_count, created_by_user_id, published_at)
    select w.id, 1, $3, $2,
           now() - make_interval(mins => (row_number() over (order by w.title))::int)
    from app.works w
    where w.title like $1 and w.visibility = 'public'`, [`${MARK}%`, admin.id, CHAPTERS_PER_WORK]);

  await q(`
    insert into app.release_items
      (release_id, chapter_id, revision_id, editorial_position, label_raw, title)
    select r.id, c.id, c.head_revision_id, c.editorial_position, c.label_raw, ''
    from app.work_releases r
    join app.works w on w.id = r.work_id
    join app.chapters c on c.work_id = w.id
    where w.title like $1`, [`${MARK}%`]);

  await q(`
    update app.works w set active_release_id = r.id
    from app.work_releases r
    where r.work_id = w.id and w.title like $1`, [`${MARK}%`]);

  // the planner needs current statistics or the measurement is meaningless
  console.log('analyzing …');
  for (const t of ['works', 'chapters', 'chapter_revisions', 'work_releases',
    'release_items', 'work_categories', 'work_tags', 'categories', 'tags']) {
    await q(`analyze app.${t}`);
  }

  const counts = await q(`
    select
      (select count(*) from app.works where title like $1) works,
      (select count(*) from app.chapters c join app.works w on w.id=c.work_id where w.title like $1) chapters,
      (select count(*) from app.work_tags wt join app.works w on w.id=wt.work_id where w.title like $1) work_tags,
      (select count(*) from app.work_categories wc join app.works w on w.id=wc.work_id where w.title like $1) work_categories`,
    [`${MARK}%`]);
  console.log(counts[0]);
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\nNOTE: seeded chapters have no storage objects. Run --clean before');
  console.log('trusting `pnpm maintenance`\'s missing-object integrity report.');
}

try {
  if (clean) await doClean();
  else await seed();
} finally {
  await pool.end();
}
