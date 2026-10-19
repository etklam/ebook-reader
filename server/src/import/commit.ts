// First-import commit (dev-plan §12): one short DB transaction moves staged
// items into canonical works/chapters/chapter_revisions. Idempotent — the
// committed result is persisted on the job row, so a retried request returns
// the same outcome without creating anything. No storage writes happen here:
// bodies were already staged as immutable objects by the worker. M4
// (overwrite) is deliberately not implemented.
import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { chapters, chapterRevisions, importItems, importJobs, works } from '../db/schema.ts';
import {
  attachRevisionResources, revisionHash, stagedLinksByItem, type StagedResourceLink,
} from './resources.ts';
import { assignWorkTaxonomy, validateTaxonomyIds } from '../taxonomy/assign.ts';

export interface CommitRequest {
  workId?: string;
  title?: string;
  workType?: string;
  author?: string;
  description?: string;
  serialStatus?: string | null;
  /** Assigned in the same transaction, so a draft is never born unclassified. */
  categoryIds?: string[];
  tagIds?: string[];
}

export type CommitResult =
  | { ok: true; status: 200; workId: string; chapterCount: number; alreadyCommitted: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string; detail?: string };

// batched multi-row inserts (stabilization §11): a few round trips per 500
// chapters instead of several per chapter
const BATCH = 500;

// Taxonomy problems surface only after the work row exists, so they have to
// unwind the transaction rather than return — a half-committed unclassified
// draft is exactly the state this feature exists to prevent.
class TaxonomyRollback extends Error {
  // Node runs this file in strip-only TS mode, which rejects constructor
  // parameter properties; declare the field explicitly instead.
  detail: string;
  constructor(detail: string) { super(detail); this.detail = detail; }
}

export async function commitImport(
  db: NodePgDatabase,
  jobId: string,
  req: CommitRequest,
): Promise<CommitResult> {
  const taxonomy = validateTaxonomyIds(req.categoryIds ?? [], req.tagIds ?? []);
  if ('error' in taxonomy) return { ok: false, status: 400, error: taxonomy.error, detail: taxonomy.detail };
  try {
    return await commitInTransaction(db, jobId, req, taxonomy);
  } catch (error) {
    if (error instanceof TaxonomyRollback) {
      return { ok: false, status: 400, error: 'invalid_taxonomy', detail: error.detail };
    }
    throw error;
  }
}

async function commitInTransaction(
  db: NodePgDatabase,
  jobId: string,
  req: CommitRequest,
  taxonomy: { categoryIds: string[]; tagIds: string[] },
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
      if (req.serialStatus != null && !['ongoing', 'completed', 'paused'].includes(req.serialStatus)) {
        return { ok: false, status: 400, error: 'invalid_serial_status' };
      }
      const serialStatus = workType === 'short_story' ? null : (req.serialStatus ?? null) as 'ongoing' | 'completed' | 'paused' | null;
      const created = await tx.insert(works).values({ title, workType, serialStatus,
        author: (req.author ?? '').trim(), description: (req.description ?? '').trim(), visibility: 'draft' })
        .returning({ id: works.id });
      workId = created[0].id;
    }

    if (taxonomy.categoryIds.length > 0 || taxonomy.tagIds.length > 0) {
      const problem = await assignWorkTaxonomy(tx, workId!, taxonomy.categoryIds, taxonomy.tagIds);
      if (problem) throw new TaxonomyRollback(problem.detail);
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

    // resource-aware revision identity (ADR-08/IMP-17): the revision hash
    // folds in the staged resource set, so identical prose with a different
    // image is a different revision
    const linksByItem = await stagedLinksByItem(tx, jobId);
    const attached: Array<{ revisionId: string; links: StagedResourceLink[] }> = [];
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH);
      const rows = await tx.insert(chapterRevisions).values(
        slice.map((item, j) => ({
          chapterId: chapterIdByPos.get(i + j + 1)!,
          title: item.title,
          contentKey: item.contentKey,
          bodyCompareHash: item.bodyHash,
          revisionHash: revisionHash({
            title: item.title,
            bodyCompareHash: item.bodyHash,
            processorVersion: job.processorVersion,
            resourceLinks: linksByItem.get(item.id) ?? [],
          }),
          processorVersion: job.processorVersion,
          sourceImportId: jobId,
        })),
      ).returning({ id: chapterRevisions.id, chapterId: chapterRevisions.chapterId });
      for (const [j, r] of rows.entries()) {
        const links = linksByItem.get(slice[j].id) ?? [];
        if (links.length > 0) attached.push({ revisionId: r.id, links });
      }
    }
    await attachRevisionResources(tx, attached);

    // head_revision_id in one set-based statement: every chapter of this
    // (empty) work got exactly one revision in this transaction
    await tx.execute(sql`
      update app.chapters c set head_revision_id = r.id
      from app.chapter_revisions r
      where r.chapter_id = c.id and c.work_id = ${workId} and c.head_revision_id is null and c.merged_into_chapter_id is null and c.deleted_at is null`);

    await tx.update(importJobs).set({
      status: 'committed',
      committedWorkId: workId,
      committedChapterCount: items.length,
      completedAt: new Date(),
    }).where(eq(importJobs.id, jobId));

    return { ok: true, status: 200, workId, chapterCount: items.length, alreadyCommitted: false };
  });
}
