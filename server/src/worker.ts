// Import worker (§16: same repo, separate process, own bounded pool).
// Polls the PostgreSQL import queue (FOR UPDATE SKIP LOCKED claim with lease);
// crashed workers leave jobs to be reclaimed until the lease expires. Run at
// low concurrency initially (dev-plan §20: worker global concurrency 1).
import { randomUUID } from 'node:crypto';
import { makePool, makeDb, checkDatabase, closePool } from './db/client.ts';
import { localStorage } from './storage.ts';
import { runOnce } from './import/queue.ts';

const pool = makePool({
  connectionString: process.env.WORKER_DATABASE_URL ?? '',
  max: 2,
  applicationName: 'ebook-worker',
  // staging writes for large books exceed the API statement timeout
  statementTimeoutMillis: 60_000,
});
const db = makeDb(pool);
const storage = localStorage();
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1_000);
const OWNER = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

let running = true;

async function main() {
  await checkDatabase(pool);
  console.log(`worker: db ready, polling import queue as ${OWNER}`);
  while (running) {
    let processed: string | null = null;
    try {
      processed = await runOnce(db, storage, OWNER);
    } catch (e) {
      // claim/processing infrastructure errors: log sanitized detail and back off
      console.error('worker poll error:', e instanceof Error ? e.constructor.name : 'unknown');
    }
    if (!processed) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await closePool(pool);
}

process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });
main().catch((e) => {
  console.error('worker fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
