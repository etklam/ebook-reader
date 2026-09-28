// Import worker skeleton (§16: same repo, separate process, own bounded pool).
// M1: boot, readiness, idle loop. The pg-backed queue with lease/heartbeat
// and the first real job type (TXT/EPUB parse) arrive in M2.
import { makePool, checkDatabase, closePool } from './db/client.ts';

const pool = makePool({
  connectionString: process.env.WORKER_DATABASE_URL ?? '',
  max: 2,
  applicationName: 'ebook-worker',
});

let running = true;

async function main() {
  await checkDatabase(pool);
  console.log('worker: db ready, entering idle loop (queue arrives in M2)');
  while (running) {
    // ponytail: poll-and-sleep placeholder; M2 replaces with queue claim.
    await new Promise((r) => setTimeout(r, 30_000));
  }
  await closePool(pool);
}

process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });
main().catch((e) => {
  console.error('worker fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
