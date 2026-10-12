import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createImportMonitor, type ImportSnapshot } from './import-monitor.ts';
import type { ImportJob, ImportQuality } from '../api/import-types.ts';

function job(status = 'ready'): ImportJob {
  return { id: 'book', status, workId: null, detectedEncoding: 'utf-8', chapterCount: 1,
    encodingResult: null, errorCode: null, errorDetail: null, stagedChapters: 1,
    stagedNeedsReview: 0, committedWorkId: null, sourceFile: null };
}
const quality: ImportQuality = { total: 1, issueCount: 0, counts: { empty: 0, duplicates: 0, gaps: 0 }, issues: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('monitor did not reach expected state');
    await delay(1);
  }
}

test('slow job requests never overlap, then terminal status ends polling', async (t) => {
  const first = deferred<ImportJob>();
  const snapshots: ImportSnapshot[] = [];
  let calls = 0;
  const monitor = createImportMonitor({
    job: async () => { calls++; return calls === 1 ? first.promise : job('failed'); },
    quality: async () => quality,
  }, (_id, state) => snapshots.push(state), 1);
  t.after(() => monitor.stop());
  monitor.watch('book');
  await delay(15);
  assert.equal(calls, 1);
  first.resolve(job('processing'));
  await until(() => snapshots.some((state) => state.job?.status === 'failed'));
  await delay(10);
  assert.equal(calls, 2);
});

test('ready job survives transient quality failure and quality is retried independently', async (t) => {
  let jobCalls = 0, qualityCalls = 0;
  const snapshots: ImportSnapshot[] = [];
  const monitor = createImportMonitor({
    job: async () => { jobCalls++; return job(); },
    quality: async () => { qualityCalls++; if (qualityCalls === 1) throw new TypeError('network unavailable'); return quality; },
  }, (_id, state) => snapshots.push(state), 1);
  t.after(() => monitor.stop());
  monitor.watch('book');
  await until(() => snapshots.some((state) => state.quality === quality));
  assert.equal(jobCalls, 1);
  assert.equal(qualityCalls, 2);
  assert.ok(snapshots.some((state) => state.job?.status === 'ready' && state.error));
  assert.equal(snapshots.at(-1)?.error, null);
});

test('restarting the same ID discards stale quality even when transport ignores abort', async (t) => {
  const stale = deferred<ImportQuality>();
  const snapshots: ImportSnapshot[] = [];
  const signals: AbortSignal[] = [];
  let qualityCalls = 0;
  const monitor = createImportMonitor({
    job: async (_id, signal) => { signals.push(signal); return job(); },
    quality: async () => ++qualityCalls === 1 ? stale.promise : quality,
  }, (_id, state) => snapshots.push(state), 1);
  t.after(() => monitor.stop());
  monitor.watch('book');
  await until(() => qualityCalls === 1);
  monitor.watch('book');
  await until(() => snapshots.some((state) => state.quality === quality));
  assert.ok(signals[0].aborted);
  const delivered = snapshots.length;
  stale.resolve({ ...quality, issueCount: 99 });
  await delay(10);
  assert.equal(snapshots.length, delivered);
  assert.equal(snapshots.at(-1)?.quality?.issueCount, 0);
});

test('stop aborts in-flight work and suppresses updates and retries', async () => {
  const pending = deferred<ImportJob>();
  let signal!: AbortSignal, calls = 0, updates = 0;
  const monitor = createImportMonitor({
    job: async (_id, currentSignal) => { calls++; signal = currentSignal; return pending.promise; },
    quality: async () => quality,
  }, () => { updates++; }, 1);
  monitor.watch('book');
  monitor.stop();
  assert.ok(signal.aborted);
  pending.resolve(job('processing'));
  await delay(10);
  assert.equal(updates, 0);
  assert.equal(calls, 1);
});

test('permission failure stops polling while a server failure is retried', async (t) => {
  let calls = 0;
  const snapshots: ImportSnapshot[] = [];
  const monitor = createImportMonitor({
    job: async () => { calls++; throw Object.assign(new Error('forbidden'), { status: 403 }); },
    quality: async () => quality,
  }, (_id, state) => snapshots.push(state), 1);
  t.after(() => monitor.stop());
  monitor.watch('book');
  await until(() => snapshots.length > 0);
  await delay(10);
  assert.equal(calls, 1);
  assert.equal(snapshots[0].error, 'forbidden');
  const recovering = createImportMonitor({
    job: async () => { calls++; if (calls === 2) throw Object.assign(new Error('unavailable'), { status: 503 }); return job(); },
    quality: async () => quality,
  }, (_id, state) => snapshots.push(state), 1);
  t.after(() => recovering.stop());
  recovering.watch('book');
  await until(() => snapshots.some((state) => state.quality === quality));
  assert.equal(calls, 3);
});
