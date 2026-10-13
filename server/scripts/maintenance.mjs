// Reclamation entrypoint (M7 Phase 3.3). Intended for cron / a systemd timer:
//
//   pnpm --filter server maintenance            # all sweeps, storage dry-run
//   pnpm --filter server maintenance --apply    # actually delete orphans
//   pnpm --filter server maintenance --only=sessions
//
// Storage deletion defaults to a DRY RUN on purpose: the first thing an
// operator should do is read what it intends to remove. Session and token
// sweeps apply immediately — those rows cannot be referenced by anything.
import { Pool } from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1] ?? 'all';
const minAgeHours = Number(args.find((a) => a.startsWith('--min-age-hours='))?.split('=')[1] ?? 24);
const graceDays = Number(args.find((a) => a.startsWith('--grace-days='))?.split('=')[1] ?? 30);

process.env.STORAGE_ROOT ??= './storage';

const { makeDb } = await import('../src/db/client.ts');
const { localStorage } = await import('../src/storage.ts');
const { sweepSessions, sweepPasswordResets, sweepStorage } = await import('../src/maintenance/reclaim.ts');

// the worker role is correct here: DML only, no DDL
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 2 });
const db = makeDb(pool);
const storage = localStorage(process.env.STORAGE_ROOT);

const want = (name) => only === 'all' || only === name;
let failed = false;

try {
  if (want('clicks')) {
    console.log('work_clicks: retained for all-time rankings');
  }

  if (want('sessions')) {
    const r = await sweepSessions(db, { graceDays });
    console.log(`sessions: deleted ${r.deleted} expired/revoked row(s) older than ${graceDays}d`);
  }

  if (want('resets')) {
    const r = await sweepPasswordResets(db, { graceDays });
    console.log(`password_resets: deleted ${r.deleted} spent/expired token(s)`);
  }

  if (want('storage')) {
    const r = await sweepStorage(db, storage, () => storage.list(), {
      minAgeHours,
      dryRun: !apply,
    });
    console.log(
      `storage: ${r.candidates} orphan candidate(s) older than ${minAgeHours}h, `
      + `${r.retained} retained (referenced or too recent)`);
    if (r.deleted.length > 0) {
      console.log(`storage: ${apply ? 'deleted' : 'would delete'} ${r.deleted.length} object(s)`);
      for (const k of r.deleted.slice(0, 20)) console.log(`  ${k}`);
      if (r.deleted.length > 20) console.log(`  … and ${r.deleted.length - 20} more`);
    }
    if (!apply && r.candidates > 0) {
      console.log('storage: dry run — re-run with --apply to delete');
    }
    // Published content missing its object is a live outage for readers: exit
    // non-zero so a cron failure is visible. Unpublished residue is reported
    // but does not fail the run — it is common in dev databases, and alerting
    // on it would teach the operator to ignore the alert that matters.
    if (r.missingPublished.length > 0) {
      failed = true;
      console.error(`\nINTEGRITY (critical): ${r.missingPublished.length} object(s) referenced by an`);
      console.error('ACTIVE RELEASE are missing from storage. Readers get content_unavailable (409)');
      console.error('for those chapters right now. Restore from backup — do not delete anything.');
      for (const k of r.missingPublished.slice(0, 20)) console.error(`  ${k}`);
      if (r.missingPublished.length > 20) console.error(`  … and ${r.missingPublished.length - 20} more`);
    }
    if (r.missingUnpublished.length > 0) {
      console.log(
        `\nnote: ${r.missingUnpublished.length} object(s) referenced only by unpublished drafts or`
        + '\nsource files are missing. Not reader-visible. Usually residue from an import run'
        + '\nagainst a different STORAGE_ROOT (e.g. the e2e suite\'s temp dir).');
    }
  }
} finally {
  await pool.end();
}

process.exit(failed ? 1 : 0);
