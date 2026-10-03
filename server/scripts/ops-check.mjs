// Operational health check for cron / a monitoring probe (M7 Phase 4).
//
//   pnpm --filter server ops:check            # human output
//   pnpm --filter server ops:check --json     # one JSON line
//
// Exit codes:
//   0  healthy
//   1  a warning condition (stalled worker, failed imports, missing published
//      content) — something a person should look at
//   2  the database or schema is unreachable — the site is down
//
// Checks the database directly rather than through the API, so it still reports
// usefully when the API process itself is the thing that is down.
import { Pool } from 'pg';

const args = process.argv.slice(2);
const asJson = args.includes('--json');

const url = process.env.WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('WORKER_DATABASE_URL or DATABASE_URL is required');
  process.exit(2);
}

const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });

let status;
try {
  const { makeDb, checkReadiness } = await import('../src/db/client.ts');
  await checkReadiness(pool);
  const { collectOpsStatus } = await import('../src/routes/ops.ts');
  status = await collectOpsStatus(makeDb(pool));
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (asJson) console.log(JSON.stringify({ ok: false, fatal: true, error: message }));
  else console.error(`FATAL  database or schema unreachable: ${message}`);
  await pool.end().catch(() => undefined);
  process.exit(2);
} finally {
  // keep the pool for the storage check below if we got this far
}

// published content whose bytes are gone is reader-visible breakage, so it
// belongs in the same check an operator polls
const { localStorage } = await import('../src/storage.ts');
const storage = localStorage(process.env.STORAGE_ROOT ?? './storage');
const published = (await pool.query(`
  select distinct cr.content_key key
  from app.release_items ri
  join app.works w on w.active_release_id = ri.release_id
  join app.chapter_revisions cr on cr.id = ri.revision_id
  union
  select distinct r.storage_key key
  from app.release_items ri
  join app.works w on w.active_release_id = ri.release_id
  join app.chapter_revision_resources rr on rr.revision_id = ri.revision_id
  join app.resources r on r.id = rr.resource_id`)).rows;

let missing = 0;
for (const row of published) {
  if (!(await storage.exists(row.key))) missing += 1;
}
if (missing > 0) {
  status.warnings.push(
    `${missing} of ${published.length} published content object(s) are MISSING from storage — `
    + 'those chapters answer content_unavailable (409) to readers');
}

await pool.end();

if (asJson) {
  console.log(JSON.stringify({ ok: status.warnings.length === 0, ...status }));
} else {
  console.log(`queue      queued=${status.queue.queued} processing=${status.queue.processing} `
    + `failed=${status.queue.failed} staleLeases=${status.queue.staleLeases}`);
  console.log(`content    works=${status.content.works} published=${status.content.publishedWorks} `
    + `chapters=${status.content.chapters} resources=${status.content.resources}`);
  console.log(`sessions   active=${status.sessions.active} sweepable=${status.sessions.sweepable}`);
  console.log(`storage    published objects checked=${published.length} missing=${missing}`);
  if (status.warnings.length === 0) {
    console.log('\nOK  no warnings');
  } else {
    console.log('');
    for (const w of status.warnings) console.log(`WARN  ${w}`);
  }
}

process.exit(status.warnings.length === 0 ? 0 : 1);
