// PostgreSQL-backed durable import queue (dev-plan §16: no Redis/BullMQ).
// Claim uses FOR UPDATE SKIP LOCKED with a lease; the active worker renews
// the lease with a heartbeat, every write is fenced on lease_owner, and an
// expired lease with no attempts left is failed by the reaper. All
// transitions go through states.assertTransition — no implicit state changes.
// Import-specific on purpose: not a generic job framework.
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { importItemResources, importJobs, importItems, resources, sourceFiles } from '../db/schema.ts';
import type { Storage } from '../storage.ts';
import { deleteBestEffort, mapBounded } from '../storage.ts';
import { decodeTxt, EncodingError } from './encoding.ts';
import { parseTxt, type StagedChapter } from './txt-parser.ts';
import { parseEpub, EpubParseError, type ExtractedResource } from './epub-parser.ts';
import { assertTransition, IllegalTransitionError } from './states.ts';

export interface QueueOptions {
  owner: string;
  /** lease TTL: how long a silent worker holds the job before reclaim */
  leaseMs: number;
  /** heartbeat period: renewal interval while processing (< leaseMs) */
  heartbeatMs: number;
  maxAttempts: number;
  /** simultaneous staging storage writes (stabilization §5) */
  storageConcurrency: number;
}

// thrown when a worker tries to finalize a job whose lease it no longer holds
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease lost for job ${jobId}`);
  }
}

export interface JobRow {
  id: string;
  status: string;
  attemptCount: number;
  requestedEncoding: string | null;
}

// Operator-facing error detail: class + message with storage paths / cwd stripped
export function sanitizeDetail(e: unknown): string {
  const msg = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
  return msg
    .replace(process.env.STORAGE_ROOT ?? ' STORAGE_ROOT_UNSET ', '<storage>')
    .replace(process.cwd(), '<app>')
    .slice(0, 200);
}

// Atomically claim one runnable job (queued, or processing with an expired
// lease and attempts left). Returns the job id or null when idle.
export async function claimNextJob(
  db: NodePgDatabase, owner: string, opts: Pick<QueueOptions, 'leaseMs' | 'maxAttempts'>,
): Promise<string | null> {
  const res = await db.execute(sql`
    update app.import_jobs set
      status = 'processing',
      started_at = coalesce(started_at, now()),
      attempt_count = attempt_count + 1,
      lease_owner = ${owner},
      lease_expires_at = now() + make_interval(secs => ${opts.leaseMs / 1000})
    where id = (
      select id from app.import_jobs
      where status = 'queued'
         or (status = 'processing' and lease_expires_at < now() and attempt_count < ${opts.maxAttempts})
      order by created_at
      for update skip locked
      limit 1
    )
    returning id
  `);
  const rows = res.rows as { id: string }[];
  return rows[0]?.id ?? null;
}

// Reaper (stabilization §4 edge case): a worker claimed the final allowed
// attempt and died with the lease unexpired forever — such jobs must become
// failed, not stay 'processing'. Called each poll; indexed and cheap.
export async function expireExhaustedJobs(db: NodePgDatabase, maxAttempts: number): Promise<number> {
  const res = await db.execute(sql`
    update app.import_jobs set
      status = 'failed',
      error_code = 'lease_expired',
      error_detail = 'worker 在最後一次嘗試中失去音訊，租約到期後由系統標記失敗',
      completed_at = now(),
      lease_owner = null,
      lease_expires_at = null
    where status = 'processing'
      and lease_expires_at < now()
      and attempt_count >= ${maxAttempts}
    returning id
  `);
  return (res.rows as { id: string }[]).length;
}

// Lease renewal — succeeds only while this worker still owns the lease.
export async function renewLease(
  db: NodePgDatabase, jobId: string, owner: string, leaseMs: number,
): Promise<boolean> {
  const res = await db.execute(sql`
    update app.import_jobs
    set lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
    where id = ${jobId} and lease_owner = ${owner} and status = 'processing'
    returning id`);
  return (res.rows as { id: string }[]).length > 0;
}

// Heartbeat wrapper: renew the lease on an interval while fn runs. Renewal
// failures are not fatal here — the fenced final transaction decides whether
// this worker may still write (a stale worker never finalizes).
export async function withHeartbeat<T>(
  db: NodePgDatabase, jobId: string, opts: Pick<QueueOptions, 'owner' | 'leaseMs' | 'heartbeatMs'>,
  fn: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    void renewLease(db, jobId, opts.owner, opts.leaseMs).catch(() => {});
  }, opts.heartbeatMs);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

export async function getJob(db: NodePgDatabase, id: string): Promise<JobRow | null> {
  const rows = await db.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
  return rows[0] ? (rows[0] as unknown as JobRow) : null;
}

// Fenced state transition: applies `patch` only if the job is still owned by
// `owner` in state `from`; 0 affected rows means the lease was lost.
export async function transitionOwnedJob(
  db: NodePgDatabase,
  jobId: string,
  owner: string,
  from: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  assertTransition(from, patch.status as string);
  const res = await db.execute(sql`
    update app.import_jobs set ${sql.join(
      Object.entries(patch).map(([col, val]) => sql`${sql.identifier(col)} = ${val}`),
      sql`, `,
    )}
    where id = ${jobId} and lease_owner = ${owner} and status = ${from}
    returning id`);
  if ((res.rows as { id: string }[]).length === 0) throw new LeaseLostError(jobId);
  return true;
}

export async function requeueForRetry(db: NodePgDatabase, jobId: string, owner: string, detail: string): Promise<void> {
  await transitionOwnedJob(db, jobId, owner, 'processing', {
    status: 'queued',
    lease_owner: null,
    lease_expires_at: null,
    error_code: 'processing_retry',
    error_detail: detail,
  });
}

export async function failJob(
  db: NodePgDatabase, jobId: string, owner: string, code: string, detail: string,
): Promise<void> {
  await transitionOwnedJob(db, jobId, owner, 'processing', {
    status: 'failed',
    error_code: code,
    error_detail: detail,
    completed_at: new Date(),
    lease_owner: null,
    lease_expires_at: null,
  });
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Parse one job end to end: decode → split → stage bodies into private
// storage with bounded concurrency (outside any transaction) → short
// lease-fenced tx persists staged items + status. Objects created by a failed
// attempt are best-effort deleted; canonical state is never touched.
export async function processImportJob(
  db: NodePgDatabase, storage: Storage, jobId: string, opts: QueueOptions,
): Promise<void> {
  const job = await getJob(db, jobId);
  if (!job) throw new Error('job not found');
  const jobRow = (await db.select({ sourceFileId: importJobs.sourceFileId }).from(importJobs).where(eq(importJobs.id, jobId)).limit(1))[0];
  const src = (await db.select().from(sourceFiles).where(eq(sourceFiles.id, jobRow.sourceFileId)).limit(1))[0];
  if (!src) throw new Error('source file not found');

  const bytes = await storage.get(src.storageKey);
  const isEpub = src.mimeType === 'application/epub+zip';

  // either parse path yields the same staged shape; failures are operator-
  // visible job errors, never silent partial imports
  let stagedChapters: StagedChapter[];
  let detectedEncoding: string | null = null;
  let encodingResult: { confidence: string; reason: string; warnings: string[] } | null = null;
  let extractedResources: ExtractedResource[] = [];

  if (isEpub) {
    let parsed;
    try {
      parsed = await parseEpub(bytes);
    } catch (e) {
      if (e instanceof EpubParseError) {
        await failJob(db, jobId, opts.owner, e.code, e.message);
        return;
      }
      throw e;
    }
    stagedChapters = parsed.chapters;
    extractedResources = parsed.resources;
    encodingResult = { confidence: 'n/a', reason: 'EPUB 內部 XML 為 UTF-8', warnings: parsed.warnings };
  } else {
    let decoded;
    try {
      decoded = decodeTxt(bytes, job.requestedEncoding);
    } catch (e) {
      if (e instanceof EncodingError) {
        await failJob(db, jobId, opts.owner, e.code,
          e.code === 'ENCODING_UNDETERMINED'
            ? '無法可靠判斷編碼，請以指定編碼重新解析'
            : '指定的編碼無法解碼此檔案');
        return;
      }
      throw e;
    }
    const parsed = parseTxt(decoded.text);
    if (parsed.chapters.length === 0) {
      await failJob(db, jobId, opts.owner, 'EMPTY_SOURCE', '檔案沒有可匯入的內容');
      return;
    }
    stagedChapters = parsed.chapters;
    detectedEncoding = decoded.encoding;
    encodingResult = {
      confidence: decoded.confidence,
      reason: decoded.reason,
      warnings: decoded.warnings,
    };
  }

  // stage bodies as immutable storage objects first — the DB tx only records
  // keys. Bounded concurrency; never open thousands of writes at once.
  const createdKeys: string[] = [];
  try {
    const contentKeys = await mapBounded(stagedChapters, opts.storageConcurrency, async (ch) => {
      const key = await storage.put(Buffer.from(ch.body, 'utf8'), 'txt');
      createdKeys.push(key);
      return key;
    });

    // Resources are content-addressed and shared: an identical image already
    // stored by an earlier import is reused rather than written again. Done
    // outside the transaction like every other storage write (§12), and only
    // after the bytes exist do we record a row pointing at them.
    const resourceIds = new Map<string, string>();   // content hash → resources.id
    for (const res of extractedResources) {
      const [existing] = await db.select({ id: resources.id, storageKey: resources.storageKey })
        .from(resources).where(eq(resources.contentHash, res.contentHash)).limit(1);
      if (existing) {
        resourceIds.set(res.contentHash, existing.id);
        // Reusing the row is only safe if its object is actually there. If the
        // object was lost (restore gap, storage migration, a sweep bug) then
        // trusting the row would make the import silently produce chapters
        // that cannot render — and re-importing the very file that could fix
        // it would never write the bytes. We have them right here, so heal.
        if (!(await storage.exists(existing.storageKey))) {
          const healed = await storage.put(res.bytes, res.ext);
          createdKeys.push(healed);
          await db.update(resources)
            .set({ storageKey: healed, sizeBytes: res.bytes.length, mediaType: res.mediaType })
            .where(eq(resources.id, existing.id));
        }
        continue;
      }
      const key = await storage.put(res.bytes, res.ext);
      createdKeys.push(key);
      // a concurrent import may have inserted the same hash in between; the
      // unique constraint decides and we adopt the winner's row
      const inserted = await db.insert(resources).values({
        contentHash: res.contentHash,
        storageKey: key,
        mediaType: res.mediaType,
        sizeBytes: res.bytes.length,
      }).onConflictDoNothing().returning({ id: resources.id });
      if (inserted[0]) {
        resourceIds.set(res.contentHash, inserted[0].id);
      } else {
        const [winner] = await db.select({ id: resources.id })
          .from(resources).where(eq(resources.contentHash, res.contentHash)).limit(1);
        if (winner) resourceIds.set(res.contentHash, winner.id);
      }
    }
    const staged = stagedChapters.map((ch, i) => ({
      importJobId: jobId,
      position: ch.position,
      volumeLabel: ch.volumeLabel,
      labelRaw: ch.labelRaw,
      parsedLabel: ch.parsed,
      title: ch.title.slice(0, 200),
      bodyHash: sha256(ch.body),
      snippet: ch.body.replace(/\n+/g, ' ').slice(0, 120),
      warnings: ch.warnings,
      needsReview: ch.needsReview,
      contentKey: contentKeys[i],
    }));

    const anyReview = staged.some((s) => s.needsReview) || encodingResult?.confidence === 'low';
    const finalStatus = anyReview ? 'review_required' : 'ready';
    assertTransition('processing', finalStatus);
    await db.transaction(async (tx) => {
      // fence: if the lease was reclaimed, this worker must not write
      const locked = (await tx.select({ owner: importJobs.leaseOwner, status: importJobs.status })
        .from(importJobs).where(eq(importJobs.id, jobId)).for('update').limit(1))[0];
      if (!locked || locked.owner !== opts.owner || locked.status !== 'processing') {
        throw new LeaseLostError(jobId);
      }
      // idempotent reprocess: discard any items from a partially-run attempt
      // (resource associations first — they reference the item rows)
      await tx.delete(importItemResources).where(sql`${importItemResources.importItemId} in
        (select id from app.import_items where import_job_id = ${jobId})`);
      await tx.delete(importItems).where(eq(importItems.importJobId, jobId));
      const insertedItems: Array<{ id: string; position: number }> = [];
      for (let i = 0; i < staged.length; i += 200) {
        insertedItems.push(...await tx.insert(importItems).values(staged.slice(i, i + 200))
          .returning({ id: importItems.id, position: importItems.position }));
      }
      // stage which resources each item's body references (ADR-08)
      const itemIdByPosition = new Map(insertedItems.map((r) => [r.position, r.id]));
      const links = stagedChapters.flatMap((ch) => (ch.resources ?? []).flatMap((ref) => {
        const itemId = itemIdByPosition.get(ch.position);
        const resourceId = resourceIds.get(ref.contentHash);
        // a reference whose bytes could not be stored is dropped here; the
        // body marker was already omitted by the parser for the same reason
        if (!itemId || !resourceId) return [];
        return [{
          importItemId: itemId,
          resourceId,
          contentHash: ref.contentHash,
          sourceHref: ref.sourceHref.slice(0, 500),
          alt: ref.alt.slice(0, 300),
        }];
      }));
      for (let i = 0; i < links.length; i += 200) {
        await tx.insert(importItemResources).values(links.slice(i, i + 200));
      }
      await tx.update(importJobs).set({
        status: finalStatus,
        detectedFormat: isEpub ? 'epub' : 'txt',
        detectedEncoding,
        encodingResult,
        chapterCount: staged.length,
        errorCode: null,
        errorDetail: null,
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      }).where(and(eq(importJobs.id, jobId), eq(importJobs.leaseOwner, opts.owner)));
    });
  } catch (e) {
    // the attempt failed before staging became durable — its objects are
    // unreferenced, remove them (best effort; full GC is M7)
    if (!(e instanceof IllegalTransitionError)) await deleteBestEffort(storage, createdKeys);
    throw e;
  }
}

// One poll iteration: reap exhausted leases → claim → process (with
// heartbeat) → retry/fail on error. Returns the processed job id, or null
// when the queue is idle.
export async function runOnce(
  db: NodePgDatabase, storage: Storage, opts: QueueOptions,
): Promise<string | null> {
  await expireExhaustedJobs(db, opts.maxAttempts);
  const jobId = await claimNextJob(db, opts.owner, opts);
  if (!jobId) return null;
  try {
    await withHeartbeat(db, jobId, opts, () => processImportJob(db, storage, jobId, opts));
  } catch (e) {
    if (e instanceof LeaseLostError) return jobId; // someone else owns it now
    const job = await getJob(db, jobId);
    const detail = sanitizeDetail(e);
    try {
      if (job && job.attemptCount < opts.maxAttempts) {
        await requeueForRetry(db, jobId, opts.owner, detail);
      } else {
        await failJob(db, jobId, opts.owner, 'processing_error', detail);
      }
    } catch (e2) {
      if (!(e2 instanceof LeaseLostError)) throw e2;
    }
  }
  return jobId;
}
