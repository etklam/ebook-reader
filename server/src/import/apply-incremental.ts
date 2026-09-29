// Incremental apply (dev-plan §05, §11, §12). Conservative: only anchored,
// confident 'new' items (plus Admin resolutions) become chapters; 'modified'
// keeps the site version (§05 incremental contract); missing chapters stay.
// One short transaction: job lock → work lock → edit_version check → match →
// insert/renumber → persist result. Idempotent replay like commitImport.
import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { chapters, chapterRevisions, importItems, importJobs, works } from '../db/schema.ts';
import { matchChapters, type MatchResult } from './match.ts';

export interface ApplyRequest {
  baseEditVersion: number;
  /** required when unresolvable items exist with no anchored position */
  confirmAppend?: boolean;
  /** itemId → 'new' | 'exclude' | 'match:<chapterId>' (Admin decisions) */
  resolutions?: Record<string, string>;
}

export type ApplyResult =
  | {
      ok: true; status: 200; workId: string; newEditVersion: number;
      summary: { added: number; unchanged: number; modifiedKept: number; skipped: number; missingKept: number };
      alreadyApplied: boolean;
    }
  | { ok: false; status: 400 | 404 | 409; error: string; detail?: string; unresolved?: Array<{ itemId: string; labelRaw: string; itemClass: string; reason: string[] }> };

interface Insert {
  itemId: string;
  labelRaw: string;
  title: string;
  contentKey: string;
  bodyHash: string;
  /** place after this existing chapter id (anchor); null → resolved order */
  afterChapterId: string | null;
}

export async function applyIncremental(
  db: NodePgDatabase,
  jobId: string,
  req: ApplyRequest,
): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const jobRows = await tx.select().from(importJobs)
      .where(eq(importJobs.id, jobId)).for('update').limit(1);
    const job = jobRows[0];
    if (!job) return { ok: false, status: 404, error: 'not_found' };

    // idempotent replay: applied summary is persisted on the job row
    if (job.status === 'applied') {
      const saved = job.appliedResult as {
        workId: string; newEditVersion: number;
        summary: { added: number; unchanged: number; modifiedKept: number; skipped: number; missingKept: number };
      };
      return {
        ok: true, status: 200, workId: saved.workId, newEditVersion: saved.newEditVersion,
        summary: saved.summary, alreadyApplied: true,
      };
    }
    if (job.status !== 'ready' && job.status !== 'review_required') {
      return { ok: false, status: 409, error: 'not_appliable', detail: `job status is ${job.status}` };
    }
    if (!job.workId) return { ok: false, status: 400, error: 'work_required', detail: 'upload with workId to target an existing work' };

    // work row lock serializes concurrent applies/edits of the same work (§12)
    const workRows = await tx.select().from(works)
      .where(eq(works.id, job.workId)).for('update').limit(1);
    const work = workRows[0];
    if (!work) return { ok: false, status: 404, error: 'work_not_found' };
    if (work.editVersion !== req.baseEditVersion) {
      return {
        ok: false, status: 409, error: 'edit_version_conflict',
        detail: `base ${req.baseEditVersion} ≠ current ${work.editVersion}；作品已被修改，請重新比對`,
      };
    }

    const existing = await tx.select({
      id: chapters.id,
      labelRaw: chapters.labelRaw,
      editorialPosition: chapters.editorialPosition,
      bodyCompareHash: chapterRevisions.bodyCompareHash,
    }).from(chapters)
      .leftJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
      .where(eq(chapters.workId, job.workId))
      .orderBy(asc(chapters.editorialPosition));

    const items = await tx.select().from(importItems)
      .where(eq(importItems.importJobId, jobId))
      .orderBy(asc(importItems.position));

    const result = matchChapters(
      existing.map((e) => ({ ...e, bodyCompareHash: e.bodyCompareHash ?? null, title: '' })),
      items.map((i) => ({
        itemId: i.id, position: i.position, labelRaw: i.labelRaw,
        volumeLabel: i.volumeLabel, bodyHash: i.bodyHash, title: i.title,
      })),
    );

    // --- decide what this apply does -------------------------------------------
    const itemById = new Map(items.map((i) => [i.id, i]));
    const inserts: Insert[] = [];
    const skipped: string[] = [];
    const unresolved: Array<{ itemId: string; labelRaw: string; itemClass: string; reason: string[] }> = [];

    let unchanged = 0, modifiedKept = 0;
    const adminMatch = new Map<string, string>(); // itemId → chapterId
    for (const [itemId, decision] of Object.entries(req.resolutions ?? {})) {
      if (decision.startsWith('match:')) {
        const target = decision.slice('match:'.length);
        if (!existing.some((e) => e.id === target)) {
          return { ok: false, status: 400, error: 'invalid_resolution', detail: `chapter ${target} 不屬於此作品` };
        }
        adminMatch.set(itemId, target);
      }
    }

    for (const m of result.items) {
      const item = itemById.get(m.itemId)!;
      const decision = req.resolutions?.[m.itemId];
      if (m.itemClass === 'unchanged') { unchanged++; continue; }
      if (m.itemClass === 'modified') {
        // Admin-confirmed identity with new body: still keep site version in
        // incremental mode (§05); overwrite is M4. Count as kept.
        modifiedKept++;
        continue;
      }
      if (m.itemClass === 'new' && m.positionConfident) {
        inserts.push({
          itemId: m.itemId, labelRaw: item.labelRaw, title: item.title,
          contentKey: item.contentKey, bodyHash: item.bodyHash,
          afterChapterId: m.insertAfterChapterId,
        });
        continue;
      }
      // ambiguous / structural_conflict / unanchored new → needs a decision
      if (decision === 'exclude') { skipped.push(m.itemId); continue; }
      if (decision === 'new') {
        inserts.push({
          itemId: m.itemId, labelRaw: item.labelRaw, title: item.title,
          contentKey: item.contentKey, bodyHash: item.bodyHash,
          afterChapterId: m.insertAfterChapterId, // may be null → source order
        });
        continue;
      }
      const adminChapter = adminMatch.get(m.itemId);
      if (adminChapter) {
        // Admin confirmed this source item IS that existing chapter. In
        // incremental mode the site body stays (rename/revision is M4); a
        // body-identical confirmation is just an unchanged match.
        const ex = existing.find((e) => e.id === adminChapter)!;
        if (ex.bodyCompareHash === item.bodyHash) unchanged++;
        else modifiedKept++;
        continue;
      }
      if (m.itemClass === 'new' && !m.positionConfident && req.confirmAppend) {
        inserts.push({
          itemId: m.itemId, labelRaw: item.labelRaw, title: item.title,
          contentKey: item.contentKey, bodyHash: item.bodyHash,
          afterChapterId: null, // append in source order after last chapter
        });
        continue;
      }
      unresolved.push({ itemId: m.itemId, labelRaw: m.labelRaw, itemClass: m.itemClass, reason: m.reason });
    }
    if (unresolved.length > 0) {
      return { ok: false, status: 409, error: 'resolution_required', unresolved };
    }

    // --- compute merged ordering, insert new chapters, renumber ----------------
    // slots: existing chapter ids in position order; inserts attach after their
    // anchor (or, for null anchors, after the last existing chapter in source
    // order — confirmAppend semantics)
    const order: Array<{ chapterId: string } | { insert: Insert }> = existing.map((e) => ({ chapterId: e.id }));
    const srcPos = new Map(items.map((i) => [i.id, i.position]));
    const sortedInserts = [...inserts].sort((a, b) => (srcPos.get(a.itemId) ?? 0) - (srcPos.get(b.itemId) ?? 0));
    for (const ins of sortedInserts) {
      let idx: number;
      if (ins.afterChapterId) {
        idx = order.findIndex((o) => 'chapterId' in o && o.chapterId === ins.afterChapterId);
        if (idx === -1) idx = order.length - 1;
      } else {
        idx = order.length - 1;
      }
      // multiple inserts after the same anchor: place after any earlier insert
      // with the same anchor so source order is preserved
      let end = idx + 1;
      while (end < order.length) {
        const slot = order[end];
        if (!('insert' in slot) || slot.insert.afterChapterId !== ins.afterChapterId) break;
        end++;
      }
      order.splice(end, 0, { insert: ins });
    }

    // create chapters + revisions first (positions get rewritten right after;
    // the DEFERRABLE unique tolerates transient duplicates inside the tx)
    const newIds: string[] = [];
    for (const slot of order) {
      if (!('insert' in slot)) continue;
      const ins = slot.insert;
      const chapter = await tx.insert(chapters).values({
        workId: job.workId,
        labelRaw: ins.labelRaw,
        editorialPosition: 0, // rewritten below
      }).returning({ id: chapters.id });
      const revision = await tx.insert(chapterRevisions).values({
        chapterId: chapter[0].id,
        title: ins.title,
        contentKey: ins.contentKey,
        bodyCompareHash: ins.bodyHash,
        revisionHash: createHash('sha256')
          .update(`${ins.title}\n${ins.bodyHash}\n${job.processorVersion}`)
          .digest('hex'),
        processorVersion: job.processorVersion,
        sourceImportId: jobId,
      }).returning({ id: chapterRevisions.id });
      await tx.update(chapters).set({ headRevisionId: revision[0].id })
        .where(eq(chapters.id, chapter[0].id));
      newIds.push(chapter[0].id);
    }

    // renumber from the merged order. Existing slots carry their stable id;
    // new-chapter slots consume newIds in creation order (which followed the
    // merged order), so shift() pairs them correctly. Per-row updates are fine
    // at M3 scale; the DEFERRABLE unique tolerates transient duplicates.
    if (order.length > 0) {
      const newQueue = [...newIds];
      const idBySlot = order.map((slot) => ('chapterId' in slot ? slot.chapterId : newQueue.shift()!));
      for (let i = 0; i < idBySlot.length; i++) {
        await tx.update(chapters).set({ editorialPosition: i + 1 })
          .where(eq(chapters.id, idBySlot[i]));
      }
    }

    const newEditVersion = work.editVersion + 1;
    await tx.update(works).set({ editVersion: newEditVersion, updatedAt: new Date() })
      .where(eq(works.id, job.workId));

    const summary = {
      added: inserts.length,
      unchanged,
      modifiedKept,
      skipped: skipped.length,
      missingKept: result.missingFromSource.length,
    };
    const applied = { workId: job.workId, newEditVersion, summary };
    await tx.update(importJobs).set({
      status: 'applied',
      applyMode: 'incremental',
      appliedResult: applied,
      completedAt: new Date(),
    }).where(eq(importJobs.id, jobId));

    return { ok: true, status: 200, workId: job.workId, newEditVersion, summary, alreadyApplied: false };
  });
}

// Live diff preview for the Admin: the same match, nothing applied.
export async function diffImport(
  db: NodePgDatabase,
  jobId: string,
): Promise<{ ok: true; match: MatchResult; workId: string; editVersion: number } | { ok: false; status: 404 | 400; error: string; detail?: string }> {
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
  if (!job) return { ok: false, status: 404, error: 'not_found' };
  if (!job.workId) return { ok: false, status: 400, error: 'work_required' };
  if (job.status !== 'ready' && job.status !== 'review_required' && job.status !== 'applied') {
    return { ok: false, status: 400, error: 'not_ready', detail: `job status is ${job.status}` };
  }
  const [work] = await db.select({ editVersion: works.editVersion }).from(works).where(eq(works.id, job.workId)).limit(1);
  if (!work) return { ok: false, status: 404, error: 'work_not_found' };

  const existing = await db.select({
    id: chapters.id,
    labelRaw: chapters.labelRaw,
    editorialPosition: chapters.editorialPosition,
    bodyCompareHash: chapterRevisions.bodyCompareHash,
  }).from(chapters)
    .leftJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
    .where(eq(chapters.workId, job.workId))
    .orderBy(asc(chapters.editorialPosition));

  const items = await db.select().from(importItems)
    .where(eq(importItems.importJobId, jobId))
    .orderBy(asc(importItems.position));

  const match = matchChapters(
    existing.map((e) => ({ ...e, bodyCompareHash: e.bodyCompareHash ?? null, title: '' })),
    items.map((i) => ({
      itemId: i.id, position: i.position, labelRaw: i.labelRaw,
      volumeLabel: i.volumeLabel, bodyHash: i.bodyHash, title: i.title,
    })),
  );
  return { ok: true, match, workId: job.workId, editVersion: work.editVersion };
}
