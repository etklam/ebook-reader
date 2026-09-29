// First-import commit (dev-plan §12): one short DB transaction moves staged
// items into canonical works/chapters/chapter_revisions. Idempotent — the
// committed result is persisted on the job row, so a retried request returns
// the same outcome without creating anything. No storage writes happen here:
// bodies were already staged as immutable objects by the worker. M4
// (overwrite) is deliberately not implemented.
import { createHash } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { chapters, chapterRevisions, importItems, importJobs, works } from '../db/schema.ts';

export interface CommitRequest {
  workId?: string;
  title?: string;
  workType?: string;
}

export type CommitResult =
  | { ok: true; status: 200; workId: string; chapterCount: number; alreadyCommitted: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string; detail?: string };

// batched multi-row inserts (stabilization §11): a few round trips per 500
// chapters instead of several per chapter
const BATCH = 500;

export async function commitImport(
  db: NodePgDatabase,
  jobId: string,
  req: CommitRequest,
): Promise<CommitResult> {
  return db.transaction(async (tx) => {
    // row lock serializes concurrent commits of the same job
    const jobRows = await tx.select().from(importJobs)
      .where(eq(importJobs.id, jobId))
      .for('update').limit(1);
    const job = jobRows[0];
    if (!job) return { ok: false, status: 404, error: 'not_found' };

    // idempotent replay: return the persisted first-commit result
    if (job.status === 'committed') {
      return {
        ok: true, status: 200,
        workId: job.committedWorkId!,
        chapterCount: job.committedChapterCount!,
        alreadyCommitted: true,
      };
    }
    if (job.status !== 'ready' && job.status !== 'review_required') {
      return { ok: false, status: 409, error: 'not_committable', detail: `job status is ${job.status}` };
    }

    // resolve target work: reuse an explicitly-named empty work, else create
    let workId = req.workId ?? job.workId ?? null;
    if (workId) {
      const existing = await tx.select({ id: works.id }).from(works).where(eq(works.id, workId)).limit(1);
      if (existing.length === 0) return { ok: false, status: 404, error: 'work_not_found' };
      const { n } = (await tx.select({ n: sql<number>`count(*)::int` }).from(chapters).where(eq(chapters.workId, workId)))[0];
      if (n > 0) {
        // first import only — incremental apply against a non-empty work is M3
        return { ok: false, status: 409, error: 'work_not_empty', detail: 'use the incremental apply endpoint' };
      }
    } else {
      const title = (req.title ?? '').trim();
      if (!title) return { ok: false, status: 400, error: 'title_required' };
      const workType = req.workType ?? 'serial';
      if (workType !== 'short_story' && workType !== 'serial') {
        return { ok: false, status: 400, error: 'invalid_work_type' };
      }
      const created = await tx.insert(works).values({ title, workType, serialStatus: null, visibility: 'draft' })
        .returning({ id: works.id });
      workId = created[0].id;
    }

    const items = await tx.select().from(importItems)
      .where(eq(importItems.importJobId, jobId))
      .orderBy(asc(importItems.position));

    // the target work is empty, so final positions are known upfront: insert
    // chapters straight at 1..n (zipping RETURNING by position) and one
    // initial immutable revision each
    const chapterIdByPos = new Map<number, string>();
    for (let i = 0; i < items.length; i += BATCH) {
      const rows = await tx.insert(chapters).values(
        items.slice(i, i + BATCH).map((item, j) => ({
          workId,
          labelRaw: item.labelRaw,
          editorialPosition: i + j + 1,
        })),
      ).returning({ id: chapters.id, editorialPosition: chapters.editorialPosition });
      for (const r of rows) chapterIdByPos.set(r.editorialPosition, r.id);
    }

    for (let i = 0; i < items.length; i += BATCH) {
      const rows = await tx.insert(chapterRevisions).values(
        items.slice(i, i + BATCH).map((item, j) => ({
          chapterId: chapterIdByPos.get(i + j + 1)!,
          title: item.title,
          contentKey: item.contentKey,
          bodyCompareHash: item.bodyHash,
          revisionHash: createHash('sha256')
            .update(`${item.title}\n${item.bodyHash}\n${job.processorVersion}`)
            .digest('hex'),
          processorVersion: job.processorVersion,
          sourceImportId: jobId,
        })),
      ).returning({ id: chapterRevisions.id, chapterId: chapterRevisions.chapterId });
      void rows; // ids wired by the set-based head update below
    }

    // head_revision_id in one set-based statement: every chapter of this
    // (empty) work got exactly one revision in this transaction
    await tx.execute(sql`
      update app.chapters c set head_revision_id = r.id
      from app.chapter_revisions r
      where r.chapter_id = c.id and c.work_id = ${workId} and c.head_revision_id is null`);

    await tx.update(importJobs).set({
      status: 'committed',
      committedWorkId: workId,
      committedChapterCount: items.length,
      completedAt: new Date(),
    }).where(eq(importJobs.id, jobId));

    return { ok: true, status: 200, workId, chapterCount: items.length, alreadyCommitted: false };
  });
}
