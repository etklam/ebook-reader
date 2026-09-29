// Import worker (§16: same repo, separate process, own bounded pool).
// Polls the PostgreSQL import queue: lease-fenced claims with heartbeat
// renewal, a reaper for exhausted leases, and bounded staging writes.
// Run at low concurrency initially (dev-plan §20: worker concurrency 1).
import { randomUUID } from 'node:crypto';
import { loadWorkerConfig } from './config.ts';
import { makePool, makeDb, checkDatabase, closePool } from './db/client.ts';
import { localStorage } from './storage.ts';
import { runOnce, type QueueOptions } from './import/queue.ts';

const config = loadWorkerConfig();

const pool = makePool({
  connectionString: config.databaseUrl,
  max: 2,
  applicationName: 'ebook-worker',
  // staging writes for large books exceed the API statement timeout
  statementTimeoutMillis: 60_000,
  tlsMode: config.tlsMode,
  dbCaFile: config.dbCaFile,
});
const db = makeDb(pool);
const storage = localStorage(config.storageRoot);

const opts: QueueOptions = {
  owner: `worker-${process.pid}-${randomUUID().slice(0, 8)}`,
  leaseMs: config.leaseMs,
  heartbeatMs: config.heartbeatMs,
  maxAttempts: config.maxAttempts,
  storageConcurrency: config.storageConcurrency,
};

let running = true;

async function main() {
  await checkDatabase(pool);
  console.log(`worker: db ready, polling import queue as ${opts.owner}`);
  while (running) {
    let processed: string | null = null;
    try {
      processed = await runOnce(db, storage, opts);
    } catch (e) {
      // claim/processing infrastructure errors: log sanitized detail and back off
      console.error('worker poll error:', e instanceof Error ? e.constructor.name : 'unknown');
    }
    if (!processed) await new Promise((r) => setTimeout(r, config.pollMs));
  }
  await closePool(pool);
}

process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });
main().catch((e) => {
  console.error('worker fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
