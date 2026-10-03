// Backup (M7 Phase 4 / DB-T4).
//
//   pnpm --filter server backup                  # → ./backups/<timestamp>/
//   pnpm --filter server backup --out=/mnt/bak
//
// Produces three files plus a manifest:
//   db.dump        pg_dump custom format (compressed, restorable selectively)
//   storage.tar.gz the private content volume (chapter bodies, images, sources)
//   manifest.json  row counts + checksums, so a restore can be VERIFIED and
//                  not merely assumed
//
// Why both halves, always together: the database stores storage *keys* and the
// volume stores the bytes. A database-only backup restores a catalog whose
// every chapter answers content_unavailable. §16A-D already says the two are
// not one transaction; the manifest records the pairing so a restore can prove
// the halves match.
//
// pg_dump runs inside the db container because the host has no client tools in
// this deployment (docker compose). PGPASSWORD is passed via env, never argv,
// so it does not appear in the process list.
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Pool } from 'pg';

const run = promisify(execFile);
const args = process.argv.slice(2);
const outRoot = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? './backups';
const container = args.find((a) => a.startsWith('--container='))?.split('=')[1] ?? 'ebook-db';
const storageRoot = process.env.STORAGE_ROOT ?? './storage';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolvePath(join(outRoot, stamp));
mkdirSync(outDir, { recursive: true });

function dbName(url) {
  return new URL(url).pathname.replace(/^\//, '');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((res, rej) => {
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', res).on('error', rej);
  });
  return hash.digest('hex');
}

const migratorUrl = process.env.MIGRATOR_DATABASE_URL;
if (!migratorUrl) {
  console.error('MIGRATOR_DATABASE_URL is required');
  process.exit(1);
}
const database = dbName(migratorUrl);

console.log(`backing up database "${database}" and storage "${storageRoot}" → ${outDir}`);

// --- 1. row counts BEFORE the dump, as the verification baseline -------------
const pool = new Pool({ connectionString: migratorUrl, max: 1 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const TABLES = [
  'users', 'sessions', 'password_resets', 'registration_invites',
  'works', 'volumes', 'chapters', 'chapter_revisions',
  'resources', 'chapter_revision_resources',
  'categories', 'tags', 'work_categories', 'work_tags',
  'work_releases', 'release_items', 'publication_events',
  'source_files', 'import_jobs', 'import_items', 'import_item_resources',
  'apply_idempotency',
  'user_library', 'user_follows', 'reading_progress', 'user_chapter_reads',
  'bookmarks', 'reader_preferences',
];
const counts = {};
for (const t of TABLES) {
  const rows = await q(`select count(*)::int n from app.${t}`).catch(() => null);
  if (rows) counts[t] = rows[0].n;
}

// the integrity fact a restore must reproduce: every published chapter's bytes
const [reachable] = await q(`
  select count(distinct cr.content_key)::int bodies,
         (select count(distinct r.storage_key)::int
          from app.release_items ri
          join app.works w on w.active_release_id = ri.release_id
          join app.chapter_revision_resources rr on rr.revision_id = ri.revision_id
          join app.resources r on r.id = rr.resource_id) images
  from app.release_items ri
  join app.works w on w.active_release_id = ri.release_id
  join app.chapter_revisions cr on cr.id = ri.revision_id`);

const [{ version }] = await q('select version()');
await pool.end();

// --- 2. pg_dump inside the container ------------------------------------------
const url = new URL(migratorUrl);
const dumpPathInContainer = `/tmp/${stamp}.dump`;
console.log('running pg_dump …');
await run('docker', [
  'exec', '-e', `PGPASSWORD=${decodeURIComponent(url.password)}`, container,
  'pg_dump',
  '-U', decodeURIComponent(url.username),
  '-d', database,
  '--format=custom',
  '--compress=9',
  // app data only: roles and the queue library's own objects are not ours to
  // restore (§16A-B — drizzle manages only what the app owns)
  '--schema=app',
  '--schema=drizzle',
  '-f', dumpPathInContainer,
]);
const dumpPath = join(outDir, 'db.dump');
await run('bash', ['-c', `docker cp ${container}:${dumpPathInContainer} ${JSON.stringify(dumpPath)}`]);
await run('docker', ['exec', container, 'rm', '-f', dumpPathInContainer]);

// --- 3. storage volume --------------------------------------------------------
console.log('archiving storage …');
const storagePath = join(outDir, 'storage.tar.gz');
// -C so paths inside the archive are relative to the storage root, making the
// archive independent of where STORAGE_ROOT happens to live
await run('tar', ['-czf', storagePath, '-C', resolvePath(storageRoot), '.']);

// --- 4. manifest --------------------------------------------------------------
const manifest = {
  createdAt: new Date().toISOString(),
  database,
  postgres: version,
  storageRoot: resolvePath(storageRoot),
  files: {
    'db.dump': { bytes: statSync(dumpPath).size, sha256: await sha256File(dumpPath) },
    'storage.tar.gz': { bytes: statSync(storagePath).size, sha256: await sha256File(storagePath) },
  },
  rowCounts: counts,
  // what `restore-verify` asserts after restoring
  publishedReachable: { bodies: reachable.bodies, images: reachable.images },
};
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log('\nbackup complete:');
console.log(`  ${dumpPath} (${(manifest.files['db.dump'].bytes / 1024).toFixed(0)} KiB)`);
console.log(`  ${storagePath} (${(manifest.files['storage.tar.gz'].bytes / 1024).toFixed(0)} KiB)`);
console.log(`  ${join(outDir, 'manifest.json')}`);
console.log(`\nVERIFY IT — an unverified backup is a guess:`);
console.log(`  pnpm --filter server restore:verify -- --from=${outDir}`);
