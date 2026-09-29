// Reanalyze (dev-plan §07 encoding preview→review loop, stabilization §3/§5):
// re-queue a finished job for a fresh parse, optionally with an explicit
// encoding. Terminal states (committed/applied/cancelled) are never
// re-analyzed — 'applied' in particular is terminal because its canonical
// result is already durable. Old staged storage objects are removed unless a
// chapter revision (canonical content) still references them.
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { chapterRevisions, importItems, importJobs } from '../db/schema.ts';
import type { Storage } from '../storage.ts';
import { deleteBestEffort } from '../storage.ts';
import { canTransition } from './states.ts';

export type ReanalyzeResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: string; detail?: string };

const REANALYZABLE = ['ready', 'review_required', 'failed'];

export async function reanalyzeImport(
  db: NodePgDatabase, storage: Storage, jobId: string,
  encoding: string | null, maxAttempts: number,
): Promise<ReanalyzeResult> {
  const rows = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
  const job = rows[0];
  if (!job) return { ok: false, status: 404, error: 'not_found' };
  if (!REANALYZABLE.includes(job.status)) {
    return { ok: false, status: 409, error: 'invalid_state', detail: `job status is ${job.status}` };
  }
  if (job.attemptCount >= maxAttempts) {
    return { ok: false, status: 409, error: 'max_attempts_reached' };
  }

  // old staged keys: replaced in the DB first, objects removed only after the
  // swap is durable and only when nothing canonical references them
  const oldItems = await db.select({ contentKey: importItems.contentKey })
    .from(importItems).where(eq(importItems.importJobId, jobId));
  const oldKeys = oldItems.map((i) => i.contentKey);

  await db.transaction(async (tx) => {
    // lock + re-check: concurrent apply/commit between the read above and now
    const locked = (await tx.select({ status: importJobs.status })
      .from(importJobs).where(eq(importJobs.id, jobId)).for('update').limit(1))[0];
    if (!locked || !canTransition(locked.status, 'queued')) {
      throw new Error(`job became ${locked?.status ?? 'missing'} during reanalyze`);
    }
    await tx.delete(importItems).where(eq(importItems.importJobId, jobId));
    await tx.update(importJobs).set({
      status: 'queued',
      requestedEncoding: encoding ?? job.requestedEncoding,
      chapterCount: null,
      detectedEncoding: null,
      encodingResult: null,
      errorCode: null,
      errorDetail: null,
      completedAt: null,
    }).where(eq(importJobs.id, jobId));
  });

  if (oldKeys.length > 0) {
    const referenced = new Set(
      (await db.select({ contentKey: chapterRevisions.contentKey })
        .from(chapterRevisions)
        .where(sql`${chapterRevisions.contentKey} = any(${oldKeys})`))
        .map((r) => r.contentKey),
    );
    await deleteBestEffort(storage, oldKeys.filter((k) => !referenced.has(k)));
  }
  return { ok: true };
}
