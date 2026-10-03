// Restore drill (M7 Phase 4 / DB-T4).
//
//   pnpm --filter server restore:verify -- --from=./backups/<timestamp>
//
// Restores a backup into a THROWAWAY database and storage directory, then
// proves the restored copy is usable rather than merely present:
//
//   1. file checksums match the manifest
//   2. every table's row count matches the manifest
//   3. the schema is the one the API expects (same readiness probe)
//   4. every published chapter's body object exists in the restored storage
//   5. every published image object exists in the restored storage
//   6. a published chapter actually reads end to end through the real API
//      wired to the restored database and storage
//
// Step 6 is the point. Steps 1–5 can all pass on a backup that the application
// cannot serve; "the dump restored without errors" is not the same claim as
// "readers can read".
//
// The scratch database is dropped at the end unless --keep is passed. The live
// database is never touched.
//
// Requires a superuser connection (RESTORE_SUPERUSER_URL), because creating a
// database is exactly the privilege the runtime and migrator roles are denied
// by design (§16A-B). The drill works around that by being given a different
// credential, never by granting CREATEDB to a role that should not have it.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';

const run = promisify(execFile);
const args = process.argv.slice(2);
const from = args.find((a) => a.startsWith('--from='))?.split('=')[1];
const container = args.find((a) => a.startsWith('--container='))?.split('=')[1] ?? 'ebook-db';
const keep = args.includes('--keep');

if (!from) {
  console.error('usage: restore-verify.mjs --from=./backups/<timestamp> [--keep]');
  process.exit(1);
}
const dir = resolvePath(from);
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

const failures = [];
const ok = (label) => console.log(`PASS  ${label}`);
const bad = (label, detail) => { failures.push(`${label}: ${detail}`); console.log(`FAIL  ${label}  ${detail}`); };

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((res, rej) => {
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', res).on('error', rej);
  });
  return hash.digest('hex');
}

const superUrlRaw = args.find((a) => a.startsWith('--superuser-url='))?.split('=')[1]
  ?? process.env.RESTORE_SUPERUSER_URL;
if (!superUrlRaw) {
  console.error('restore-verify needs a superuser connection to create a scratch database.');
  console.error('The migrator role deliberately cannot CREATE DATABASE (§16A-B), so supply:');
  console.error('');
  console.error('  RESTORE_SUPERUSER_URL=postgres://postgres:<pass>@127.0.0.1:5432/postgres \\');
  console.error('    pnpm --filter server restore:verify -- --from=<dir>');
  console.error('');
  console.error('Dev default for this repo\'s docker-compose:');
  console.error('  postgres://postgres:dev-only-superuser@127.0.0.1:5432/postgres');
  process.exit(1);
}
const superUrl = new URL(superUrlRaw);
const migratorUrl = superUrl;   // host/port for the scratch connection string
const superUser = decodeURIComponent(superUrl.username);
const superPass = decodeURIComponent(superUrl.password);
const scratchDb = `restore_check_${Date.now()}`;
const scratchStorage = mkdtempSync(join(tmpdir(), 'ebook-restore-'));

const dockerPsql = (sql, db = 'postgres') => run('docker', [
  'exec', '-e', `PGPASSWORD=${superPass}`, container,
  'psql', '-U', superUser, '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql,
]);

console.log(`restore drill from ${dir}`);
console.log(`scratch database: ${scratchDb}`);
console.log(`scratch storage:  ${scratchStorage}\n`);

try {
  // --- 1. checksums -----------------------------------------------------------
  for (const [name, meta] of Object.entries(manifest.files)) {
    const path = join(dir, name);
    if (!existsSync(path)) { bad(`file present: ${name}`, 'missing'); continue; }
    const actual = await sha256File(path);
    if (actual === meta.sha256) ok(`checksum: ${name}`);
    else bad(`checksum: ${name}`, `expected ${meta.sha256.slice(0, 12)}, got ${actual.slice(0, 12)}`);
  }
  if (failures.length > 0) throw new Error('backup files are corrupt; stopping before restore');

  // --- 2. restore the dump into a scratch database ----------------------------
  await dockerPsql(`create database ${scratchDb}`);
  const inContainer = `/tmp/${scratchDb}.dump`;
  await run('bash', ['-c', `docker cp ${JSON.stringify(join(dir, 'db.dump'))} ${container}:${inContainer}`]);
  // the dump carries app+drizzle schemas; roles are environment config, not
  // backup content, so ownership is remapped to the restoring superuser
  await run('docker', [
    'exec', '-e', `PGPASSWORD=${superPass}`, container,
    'pg_restore', '-U', superUser, '-d', scratchDb,
    '--no-owner', '--no-privileges', '--exit-on-error', inContainer,
  ]);
  await run('docker', ['exec', container, 'rm', '-f', inContainer]);
  ok('pg_restore completed without error');

  // --- 3. row counts ----------------------------------------------------------
  const scratchUrl = `postgres://${encodeURIComponent(superUser)}:${encodeURIComponent(superPass)}`
    + `@${migratorUrl.hostname}:${migratorUrl.port}/${scratchDb}`;
  const pool = new Pool({ connectionString: scratchUrl, max: 2 });
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

  let countMismatch = 0;
  for (const [table, expected] of Object.entries(manifest.rowCounts)) {
    const rows = await q(`select count(*)::int n from app.${table}`).catch(() => null);
    if (!rows) { bad(`row count: ${table}`, 'table missing'); countMismatch++; continue; }
    if (rows[0].n !== expected) { bad(`row count: ${table}`, `expected ${expected}, got ${rows[0].n}`); countMismatch++; }
  }
  if (countMismatch === 0) ok(`row counts match for ${Object.keys(manifest.rowCounts).length} tables`);

  // --- 4. the schema the API expects ------------------------------------------
  const { checkReadiness } = await import('../src/db/client.ts');
  await checkReadiness(pool).then(() => ok('schema readiness probe passes'))
    .catch((e) => bad('schema readiness probe', e.message));

  // --- 5. unpack storage and check published objects --------------------------
  await run('tar', ['-xzf', join(dir, 'storage.tar.gz'), '-C', scratchStorage]);
  const { localStorage } = await import('../src/storage.ts');
  const storage = localStorage(scratchStorage);

  const bodies = await q(`
    select distinct cr.content_key key
    from app.release_items ri
    join app.works w on w.active_release_id = ri.release_id
    join app.chapter_revisions cr on cr.id = ri.revision_id`);
  const images = await q(`
    select distinct r.storage_key key
    from app.release_items ri
    join app.works w on w.active_release_id = ri.release_id
    join app.chapter_revision_resources rr on rr.revision_id = ri.revision_id
    join app.resources r on r.id = rr.resource_id`);

  const missingBodies = [];
  for (const b of bodies) if (!(await storage.exists(b.key))) missingBodies.push(b.key);
  const missingImages = [];
  for (const i of images) if (!(await storage.exists(i.key))) missingImages.push(i.key);

  if (bodies.length !== manifest.publishedReachable.bodies) {
    bad('published body count', `expected ${manifest.publishedReachable.bodies}, got ${bodies.length}`);
  }
  if (missingBodies.length === 0) ok(`all ${bodies.length} published chapter bodies present in restored storage`);
  else bad('published chapter bodies', `${missingBodies.length} missing (e.g. ${missingBodies[0]})`);
  if (missingImages.length === 0) ok(`all ${images.length} published images present in restored storage`);
  else bad('published images', `${missingImages.length} missing (e.g. ${missingImages[0]})`);

  // --- 6. read a published chapter through the real API -----------------------
  // The claim worth making is "a reader can read it", which only the actual
  // request path can establish.
  const [sample] = await q(`
    select ri.chapter_id
    from app.release_items ri
    join app.works w on w.active_release_id = ri.release_id
    where w.visibility in ('public','unlisted')
    order by ri.editorial_position limit 1`);
  if (!sample) {
    console.log('SKIP  end-to-end read: the backup contains no published chapter');
  } else {
    process.env.DATABASE_URL = scratchUrl;
    process.env.STORAGE_ROOT = scratchStorage;
    process.env.DB_TLS = 'disable';
    const { app, apiPool } = await import('../src/index.ts');
    const res = await app.request(`/api/reader/chapters/${sample.chapter_id}`);
    const body = await res.text();
    if (res.status !== 200) {
      bad('end-to-end read of a published chapter', `status ${res.status} ${body.slice(0, 120)}`);
    } else {
      const parsed = JSON.parse(body);
      if (typeof parsed.body === 'string' && parsed.paragraphCount > 0) {
        ok(`end-to-end read: chapter served ${parsed.paragraphCount} paragraphs from the restored copy`);
      } else {
        bad('end-to-end read', 'chapter returned no paragraphs');
      }
    }
    // close the API's own pool before the scratch database is dropped,
    // otherwise its connections are terminated under it
    await apiPool.end().catch(() => undefined);
  }

  await pool.end();
} finally {
  if (!keep) {
    await dockerPsql(`drop database if exists ${scratchDb} with (force)`).catch(() => undefined);
    rmSync(scratchStorage, { recursive: true, force: true });
    console.log('\nscratch database and storage removed');
  } else {
    console.log(`\nkept: database ${scratchDb}, storage ${scratchStorage}`);
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`RESTORE DRILL FAILED — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nThis backup must not be relied on.');
  process.exit(1);
}
console.log('RESTORE DRILL PASSED — this backup restores to a readable system.');
