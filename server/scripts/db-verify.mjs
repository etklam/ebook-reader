// DB-01/02/03 acceptance checks (dev-plan §16A-K). L2 stage-gate grade:
// runs against the real dockerized PG. Assumes `pnpm db:migrate` succeeded.
// Run: node --env-file=.env scripts/db-verify.mjs
import { Pool } from 'pg';

const results = [];
const failures = [];
const check = (id, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
  if (!ok) failures.push(id);
};
const expectError = async (pool, sql, params, code) => {
  try {
    await pool.query(sql, params ?? []);
    return false;
  } catch (e) {
    return e.code === code;
  }
};

const api = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const worker = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 1 });
const migrator = new Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL, max: 1 });

// --- DB-01: migration produced the expected objects on an empty DB ----------
{
  const { rows } = await migrator.query(
    `select table_name from information_schema.tables where table_schema='app' order by 1`);
  const names = rows.map((r) => r.table_name);
  const expected = ['categories', 'chapter_revisions', 'chapters', 'import_items', 'import_jobs',
    'sessions', 'source_files', 'tags', 'users', 'volumes', 'work_categories', 'work_tags', 'works'];
  const missing = expected.filter((t) => !names.includes(t));
  check('DB-01 tables', missing.length === 0, missing.length ? `missing: ${missing}` : `${names.length} tables`);

  const def = await migrator.query(
    `select condeferrable from pg_constraint where conname='chapters_work_position_uq'`);
  check('DB-01 deferrable position', def.rows[0]?.condeferrable === true);

  const fk = await migrator.query(
    `select count(*)::int as n from pg_constraint where conname='chapters_head_revision_fk' and confdeltype='a'`);
  check('DB-01 composite head-revision FK', fk.rows[0].n === 1);
}

// --- DB-02: runtime roles are table-level consumers, nothing more -----------
{
  check('DB-02 api cannot DDL', await expectError(api, 'CREATE TABLE app.hack(id int)', [], '42501'));
  check('DB-02 worker cannot DDL', await expectError(worker, 'CREATE TABLE app.hack(id int)', [], '42501'));
  check('DB-02 api cannot become migrator', await expectError(api, 'SET ROLE ebook_migrator', [], '42501'));
  const superuser = await api.query('select rolsuper from pg_roles where rolname = current_user');
  check('DB-02 api not superuser', superuser.rows[0].rolsuper === false);
  // any prior e2e runs may have left draft works in dev — the point is that
  // the worker role can read app tables, not that the table is empty
  const wr = await worker.query('select count(*)::int as n from app.works');
  check('DB-02 worker DML works', typeof wr.rows[0].n === 'number');
}

// --- DB-03: irregular labels, duplicates, cross-chapter revision ------------
{
  // clear any leftovers from a partially-failed previous run
  for (const row of (await api.query(
    `select id from app.works where title='驗收測試書'`)).rows) {
    await api.query(`update app.chapters set head_revision_id=null where work_id=$1`, [row.id]);
    await api.query(`delete from app.work_categories where work_id=$1`, [row.id]);
    await api.query(`delete from app.work_tags where work_id=$1`, [row.id]);
    await api.query(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [row.id]);
    await api.query(`delete from app.chapters where work_id=$1`, [row.id]);
    await api.query(`delete from app.works where id=$1`, [row.id]);
  }
  const w = await api.query(
    `insert into app.works (title, work_type) values ('驗收測試書', 'serial') returning id`);
  const workId = w.rows[0].id;

  // irregular labels stored verbatim, duplicates of the *label* are legal
  const labels = ['第12.10章', '第12.1章', '第12.5.1章', '第012章', '第012章', '風起'];
  for (let i = 0; i < labels.length; i++) {
    await api.query(
      `insert into app.chapters (work_id, label_raw, editorial_position) values ($1,$2,$3)`,
      [workId, labels[i], i + 1]);
  }
  const stored = await api.query(
    `select label_raw from app.chapters where work_id=$1 order by editorial_position`, [workId]);
  check('DB-03 labels verbatim',
    JSON.stringify(stored.rows.map((r) => r.label_raw)) === JSON.stringify(labels),
    '12.10/12.1 coexist, duplicate label kept');

  // deferrable unique actually defers: bulk shift inside one transaction
  const shift = await api.query('begin'); void shift;
  try {
    await api.query(`update app.chapters set editorial_position = editorial_position + 100 where work_id=$1`, [workId]);
    await api.query('commit');
    check('DB-03 deferred position shift', true);
  } catch {
    await api.query('rollback');
    check('DB-03 deferred position shift', false, 'range shift failed without DEFERRED');
  }

  // duplicate taxonomy assignment rejected by PK (vocab inserts idempotent
  // so the script is re-runnable after a partial failure)
  const cat = await api.query(
    `insert into app.categories (display_name) values ('玄幻') on conflict do nothing returning id`);
  const catId = cat.rows[0]?.id
    ?? (await api.query(`select id from app.categories where display_name='玄幻'`)).rows[0].id;
  const tag = await api.query(
    `insert into app.tags (display_name) values ('重生') on conflict do nothing returning id`);
  const tagId = tag.rows[0]?.id
    ?? (await api.query(`select id from app.tags where display_name='重生'`)).rows[0].id;
  await api.query(`insert into app.work_categories values ($1,$2,now())`, [workId, catId]);
  check('DB-03 duplicate work_categories rejected',
    await expectError(api, `insert into app.work_categories values ($1,$2,now())`, [workId, catId], '23505'));
  await api.query(`insert into app.work_tags values ($1,$2,now())`, [workId, tagId]);
  check('DB-03 duplicate work_tags rejected',
    await expectError(api, `insert into app.work_tags values ($1,$2,now())`, [workId, tagId], '23505'));

  // revision from another chapter cannot become head_revision (composite FK)
  const c1 = await api.query(
    `insert into app.chapters (work_id, label_raw, editorial_position) values ($1,'x1',900) returning id`, [workId]);
  const c2 = await api.query(
    `insert into app.chapters (work_id, label_raw, editorial_position) values ($1,'x2',901) returning id`, [workId]);
  const revOfC1 = await api.query(
    `insert into app.chapter_revisions (chapter_id, title, content_key, body_compare_hash, revision_hash, processor_version)
     values ($1,'t','k','h1','h2','v1') returning id`, [c1.rows[0].id]);
  check('DB-03 cross-chapter head_revision rejected',
    await expectError(api,
      `update app.chapters set head_revision_id=$1 where id=$2`,
      [revOfC1.rows[0].id, c2.rows[0].id], '23503'));
  // pointing at own chapter's revision is fine
  await api.query(`update app.chapters set head_revision_id=$1 where id=$2`, [revOfC1.rows[0].id, c1.rows[0].id]);
  check('DB-03 own head_revision accepted', true);

  // cleanup: verify script must be re-runnable (detach heads, then revisions,
  // then chapters — the composite FK blocks deleting referenced revisions)
  await api.query(`update app.chapters set head_revision_id=null where work_id=$1`, [workId]);
  await api.query(`delete from app.work_categories where work_id=$1`, [workId]);
  await api.query(`delete from app.work_tags where work_id=$1`, [workId]);
  await api.query(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [workId]);
  await api.query(`delete from app.chapters where work_id=$1`, [workId]);
  await api.query(`delete from app.works where id=$1`, [workId]);
}

// --- M2 additions: volume ownership composite FK + domain CHECKs -------------
{
  const cleanup = async () => {
    for (const row of (await api.query(
      `select id from app.works where title like 'M2驗收%'`)).rows) {
      await api.query(`update app.chapters set head_revision_id=null where work_id=$1`, [row.id]);
      await api.query(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id=$1)`, [row.id]);
      await api.query(`delete from app.chapters where work_id=$1`, [row.id]);
      await api.query(`delete from app.volumes where work_id=$1`, [row.id]);
      await api.query(`delete from app.works where id=$1`, [row.id]);
    }
  };
  await cleanup();

  const w1 = (await api.query(
    `insert into app.works (title, work_type) values ('M2驗收A', 'serial') returning id`)).rows[0].id;
  const w2 = (await api.query(
    `insert into app.works (title, work_type) values ('M2驗收B', 'short_story') returning id`)).rows[0].id;
  const vol1 = (await api.query(
    `insert into app.volumes (work_id, title, position) values ($1,'卷一',1) returning id`, [w1])).rows[0].id;

  // A2: a chapter of work B cannot reference a volume of work A
  check('M2-01 cross-work volume rejected',
    await expectError(api,
      `insert into app.chapters (work_id, volume_id, label_raw, editorial_position) values ($1,$2,'x',1)`,
      [w2, vol1], '23503'));
  // same work's volume is fine
  await api.query(
    `insert into app.chapters (work_id, volume_id, label_raw, editorial_position) values ($1,$2,'x',1)`, [w1, vol1]);
  check('M2-01 same-work volume accepted', true);

  // A3: CHECK constraints reject invalid domain values
  check('M2-02 bad users.role rejected',
    await expectError(api, `insert into app.users (username,email,password_hash,role) values ('u','u@x.y','h','god')`, [], '23514'));
  check('M2-02 bad works.work_type rejected',
    await expectError(api, `insert into app.works (title, work_type) values ('t','novel')`, [], '23514'));
  check('M2-02 bad works.serial_status rejected',
    await expectError(api, `insert into app.works (title, work_type, serial_status) values ('t','serial','dropped')`, [], '23514'));
  check('M2-02 bad works.visibility rejected',
    await expectError(api, `insert into app.works (title, work_type, visibility) values ('t','serial','hidden')`, [], '23514'));
  check('M2-02 short_story with serial_status rejected',
    await expectError(api, `insert into app.works (title, work_type, serial_status) values ('t','short_story','ongoing')`, [], '23514'));
  check('M2-02 short_story null serial_status accepted', (() => true)());
  // valid values still insert fine (w2 already proved short_story/null)
  await api.query(`insert into app.works (title, work_type, serial_status, visibility) values ('M2驗收C','serial','completed','unlisted')`);
  check('M2-02 valid serial_status accepted', true);

  await cleanup();
}

await api.end(); await worker.end(); await migrator.end();
console.log(results.join('\n'));
if (failures.length) {
  console.error(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nall DB checks passed');
