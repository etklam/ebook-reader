// Protected revert (dev-plan §12, VER-02). An apply persists an exact change
// snapshot (chapters it created, head revisions it moved); the revert undoes
// exactly that — and only while the work is still at the version that apply
// produced. Any later edit blocks the revert with an explicit conflict;
// automatic compensation plans are deferred backlog per v1.3.
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { chapters, importJobs, releaseItems, works } from '../db/schema.ts';
import { assertTransition } from './states.ts';
import type { AppliedSnapshot } from './apply-incremental.ts';

export type RevertPreview =
  | {
      ok: true; workId: string;
      canRevert: boolean; reason: string | undefined;
      plan: { removeChapters: number; restoreRevisions: number; editVersionFrom: number; editVersionTo: number };
    }
  | { ok: false; status: 404 | 400; error: string; detail?: string };

export type RevertResult =
  | { ok: true; status: 200; workId: string; removedChapters: number; restoredRevisions: number; editVersion: number; alreadyReverted: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string; detail?: string };

type Loaded =
  | { ok: false; error: string; detail?: string }
  | { ok: true; job: NonNullable<Awaited<ReturnType<typeof loadJob>>>; snapshot: AppliedSnapshot };

async function loadJob(db: NodePgDatabase, jobId: string) {
  const rows = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
  return rows[0];
}

async function loadSnapshot(db: NodePgDatabase, jobId: string): Promise<Loaded> {
  const job = await loadJob(db, jobId);
  if (!job) return { ok: false, error: 'not_found' };
  if (job.status !== 'applied' && job.status !== 'reverted') {
    return { ok: false, error: 'not_applied', detail: `job status is ${job.status}` };
  }
  if (!job.workId) return { ok: false, error: 'not_applied', detail: 'job has no target work' };
  return { ok: true, job, snapshot: job.appliedResult as AppliedSnapshot };
}

export async function revertPlan(db: NodePgDatabase, jobId: string): Promise<RevertPreview> {
  const loaded = await loadSnapshot(db, jobId);
  if (!loaded.ok) {
    return { ok: false, status: 404, error: loaded.error, detail: loaded.detail };
  }
  const { job, snapshot } = loaded;
  const [work] = await db.select({ editVersion: works.editVersion })
    .from(works).where(eq(works.id, job.workId!)).limit(1);
  if (!work) return { ok: false, status: 404, error: 'work_not_found' };

  const alreadyReverted = job.status === 'reverted';
  const stale = work.editVersion !== snapshot.newEditVersion;
  return {
    ok: true, workId: job.workId!,
    canRevert: !alreadyReverted && !stale,
    reason: alreadyReverted ? '此匯入已回復'
      : stale ? `作品已在 v${snapshot.newEditVersion} 之後被修改（現在 v${work.editVersion}）；回復會撤銷他人改動，不允許`
      : undefined,
    plan: {
      removeChapters: snapshot.addedChapterIds.length,
      restoreRevisions: snapshot.revisionChanges.length,
      editVersionFrom: snapshot.newEditVersion,
      editVersionTo: snapshot.newEditVersion - 1,
    },
  };
}

export async function revertImport(
  db: NodePgDatabase, jobId: string, req: { baseEditVersion: number },
): Promise<RevertResult> {
  return db.transaction(async (tx) => {
    const jobRows = await tx.select().from(importJobs)
      .where(eq(importJobs.id, jobId)).for('update').limit(1);
    const job = jobRows[0];
    if (!job) return { ok: false, status: 404, error: 'not_found' };

    // idempotent replay: a reverted job re-reports its outcome, changes nothing
    if (job.status === 'reverted') {
      const snapshot = job.appliedResult as AppliedSnapshot;
      return {
        ok: true, status: 200, workId: snapshot.workId,
        removedChapters: snapshot.addedChapterIds.length,
        restoredRevisions: snapshot.revisionChanges.length,
        editVersion: snapshot.newEditVersion - 1, alreadyReverted: true,
      };
    }
    if (job.status !== 'applied') {
      return { ok: false, status: 409, error: 'not_applied', detail: `job status is ${job.status}` };
    }
    const snapshot = job.appliedResult as AppliedSnapshot;

    const workRows = await tx.select().from(works)
      .where(eq(works.id, job.workId!)).for('update').limit(1);
    const work = workRows[0];
    if (!work) return { ok: false, status: 404, error: 'work_not_found' };
    // VER-02: later edits block the revert — never undo another Admin's work
    if (work.editVersion !== snapshot.newEditVersion) {
      return {
        ok: false, status: 409, error: 'revert_conflict',
        detail: `作品已修改到 v${work.editVersion}（此匯入產生 v${snapshot.newEditVersion}）；補償計劃屬 backlog，請手動處理`,
      };
    }
    if (work.editVersion !== req.baseEditVersion) {
      return { ok: false, status: 409, error: 'edit_version_conflict', detail: `base ${req.baseEditVersion} ≠ current ${work.editVersion}` };
    }

    // published releases reference immutable revisions/chapters — a revert
    // must never physically delete content a release snapshot still points at
    // (§47). Editorial rollback across a publication is a manual operation.
    const revisionRefs = snapshot.revisionChanges.length > 0
      ? await tx.select({ id: releaseItems.revisionId }).from(releaseItems)
        .where(inArray(releaseItems.revisionId, snapshot.revisionChanges.map((r) => r.newRevisionId))).limit(1)
      : [];
    const chapterRefs = snapshot.addedChapterIds.length > 0
      ? await tx.select({ id: releaseItems.chapterId }).from(releaseItems)
        .where(inArray(releaseItems.chapterId, snapshot.addedChapterIds)).limit(1)
      : [];
    if (revisionRefs.length > 0 || chapterRefs.length > 0) {
      return {
        ok: false, status: 409, error: 'revert_published',
        detail: '此匯入的內容已被發布快照引用；歷史 release 不可破壞，請以新匯入/新發布修正內容',
      };
    }

    // 1) restore moved head revisions, then drop the revisions this apply made
    if (snapshot.revisionChanges.length > 0) {
      await tx.execute(sql`
        update app.chapters c set head_revision_id = v.prev
        from unnest(${sql.param(snapshot.revisionChanges.map((r) => r.chapterId))}::uuid[],
                    ${sql.param(snapshot.revisionChanges.map((r) => r.previousHeadRevisionId))}::uuid[]) as v(id, prev)
        where c.id = v.id`);
      await tx.execute(sql`
        delete from app.chapter_revisions where id = any(${sql.param(snapshot.revisionChanges.map((r) => r.newRevisionId))}::uuid[])`);
    }

    // 2) remove exactly the chapters this apply created (heads detached first —
    // the composite FK blocks deleting still-referenced revisions)
    if (snapshot.addedChapterIds.length > 0) {
      await tx.execute(sql`
        update app.chapters set head_revision_id = null
        where id = any(${sql.param(snapshot.addedChapterIds)}::uuid[])`);
      await tx.execute(sql`
        delete from app.chapter_revisions
        where chapter_id = any(${sql.param(snapshot.addedChapterIds)}::uuid[]) and source_import_id = ${jobId}`);
      await tx.execute(sql`
        delete from app.chapters where id = any(${sql.param(snapshot.addedChapterIds)}::uuid[])`);
    }

    // 3) compact positions back to 1..n (relative order is untouched)
    const remaining = await tx.select({ id: chapters.id })
      .from(chapters).where(eq(chapters.workId, job.workId!))
      .orderBy(asc(chapters.editorialPosition));
    if (remaining.length > 0) {
      await tx.execute(sql`
        update app.chapters c set editorial_position = v.pos
        from unnest(${sql.param(remaining.map((r) => r.id))}::uuid[],
                    ${sql.param(remaining.map((_, i) => i + 1))}::int[]) as v(id, pos)
        where c.id = v.id`);
    }

    const backTo = snapshot.newEditVersion - 1;
    await tx.update(works).set({ editVersion: backTo, updatedAt: new Date() })
      .where(eq(works.id, job.workId!));
    assertTransition(job.status, 'reverted');
    await tx.update(importJobs).set({ status: 'reverted', completedAt: new Date() })
      .where(eq(importJobs.id, jobId));

    return {
      ok: true, status: 200, workId: job.workId!,
      removedChapters: snapshot.addedChapterIds.length,
      restoredRevisions: snapshot.revisionChanges.length,
      editVersion: backTo, alreadyReverted: false,
    };
  });
}
