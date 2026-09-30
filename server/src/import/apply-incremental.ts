// Incremental apply (dev-plan §05, §11, §12). Conservative: only anchored,
// confident 'new' items (plus Admin resolutions) become chapters; 'modified'
// keeps the site version (§05 incremental contract); missing chapters stay.
// One short transaction: job lock → work lock → edit_version check → match →
// insert/renumber → persist result. Idempotent replay like commitImport.
// Writes are batched (stabilization §11): client-generated chapter ids make
// the insert→renumber mapping deterministic, and one set-based UPDATE applies
// all final positions instead of one UPDATE per chapter.
import { createHash, randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { chapters, chapterRevisions, importItems, importJobs, works, applyIdempotency } from '../db/schema.ts';
import { matchChapters, type MatchResult } from './match.ts';
import { assertTransition } from './states.ts';

/** persisted on the job row: the replay response AND the revert snapshot */
export interface AppliedSnapshot {
  workId: string;
  newEditVersion: number;
  summary: { added: number; updated: number; unchanged: number; modifiedKept: number; skipped: number; missingKept: number };
  mode: 'incremental' | 'overwrite';
  /** chapters this apply created (a revert removes exactly these) */
  addedChapterIds: string[];
  /** head-revision moves this apply made (a revert restores exactly these) */
  revisionChanges: { chapterId: string; previousHeadRevisionId: string | null; newRevisionId: string }[];
}

// stable hash of the request payload: resolutions are key-sorted so object
// key order never changes the identity of "the same operation"
function hashApplyRequest(jobId: string, req: ApplyRequest): string {
  const canonical = JSON.stringify({
    jobId,
    mode: req.mode ?? 'incremental',
    baseEditVersion: req.baseEditVersion,
    confirmAppend: req.confirmAppend === true,
    resolutions: req.resolutions
      ? Object.fromEntries(Object.entries(req.resolutions).sort(([a], [b]) => a.localeCompare(b)))
      : null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface ApplyRequest {
  baseEditVersion: number;
  /** incremental keeps site versions for modified chapters (§05); overwrite
   * creates a new immutable revision and moves head_revision_id (§12) */
  mode?: 'incremental' | 'overwrite';
  /** required when unresolvable items exist with no anchored position */
  confirmAppend?: boolean;
  /** itemId → 'new' | 'exclude' | 'match:<chapterId>' (Admin decisions) */
  resolutions?: Record<string, string>;
  /** Idempotency-Key (§12): same key+payload replays the stored response */
  idempotencyKey?: string | null;
}

export type ApplyResult =
  | {
      ok: true; status: 200; workId: string; newEditVersion: number;
      summary: { added: number; updated: number; unchanged: number; modifiedKept: number; skipped: number; missingKept: number };
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

const BATCH = 500;

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

    // Idempotency-Key (§12) FIRST — a key reused with a different payload is a
    // hard conflict even when the job was already applied (key conflict outranks
    // replay); same key+payload replays the persisted response
    const requestHash = hashApplyRequest(jobId, req);
    if (req.idempotencyKey) {
      const [rec] = await tx.select().from(applyIdempotency)
        .where(eq(applyIdempotency.key, req.idempotencyKey)).for('update').limit(1);
      if (rec) {
        if (rec.importJobId !== jobId || rec.requestHash !== requestHash) {
          return { ok: false, status: 409, error: 'idempotency_key_conflict', detail: '同一 Idempotency-Key 已用於不同操作' };
        }
        const replay = rec.response as Extract<ApplyResult, { ok: true }>;
        return { ...replay, alreadyApplied: true };
      }
    }

    // idempotent replay: applied summary is persisted on the job row
    if (job.status === 'applied' || job.status === 'reverted') {
      const saved = job.appliedResult as AppliedSnapshot;
      return {
        ok: true, status: 200, workId: saved.workId, newEditVersion: saved.newEditVersion,
        summary: saved.summary, alreadyApplied: true,
      };
    }
    if (job.status !== 'ready' && job.status !== 'review_required') {
      return { ok: false, status: 409, error: 'not_appliable', detail: `job status is ${job.status}` };
    }
    if (!job.workId) return { ok: false, status: 400, error: 'work_required', detail: 'upload with workId to target an existing work' };
    const targetWorkId = job.workId; // narrowed once; closures below need the non-null value

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
      headRevisionId: chapters.headRevisionId,
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
    const existingById = new Map(existing.map((e) => [e.id, e]));
    const inserts: Insert[] = [];
    const skipped: string[] = [];
    const unresolved: Array<{ itemId: string; labelRaw: string; itemClass: string; reason: string[] }> = [];

    let unchanged = 0, modifiedKept = 0;
    // overwrite mode: matched items with a different body become new revisions
    const updates: { chapterId: string; previousHeadRevisionId: string | null; labelRaw: string; title: string; contentKey: string; bodyHash: string }[] = [];
    const mode = req.mode ?? 'incremental';
    const adminMatch = new Map<string, string>(); // itemId → chapterId
    for (const [itemId, decision] of Object.entries(req.resolutions ?? {})) {
      if (decision.startsWith('match:')) {
        const target = decision.slice('match:'.length);
        if (!existingById.has(target)) {
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
        // §05: incremental keeps the site version; overwrite creates a new
        // immutable revision on the same chapter_id (ADR-03)
        if (mode === 'overwrite') {
          const ex = existingById.get(m.matchedChapterId!)!;
          updates.push({
            chapterId: ex.id,
            previousHeadRevisionId: ex.headRevisionId,
            labelRaw: item.labelRaw, title: item.title,
            contentKey: item.contentKey, bodyHash: item.bodyHash,
          });
        } else {
          modifiedKept++;
        }
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
        // Admin confirmed this source item IS that existing chapter. A
        // body-identical confirmation is an unchanged match; a differing body
        // follows the mode (keep site vs new revision).
        const ex = existingById.get(adminChapter)!;
        if (ex.bodyCompareHash === item.bodyHash) unchanged++;
        else if (mode === 'overwrite') {
          updates.push({
            chapterId: ex.id,
            previousHeadRevisionId: ex.headRevisionId,
            labelRaw: item.labelRaw, title: item.title,
            contentKey: item.contentKey, bodyHash: item.bodyHash,
          });
        } else modifiedKept++;
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

    // ids for new chapters are generated client-side so the batched inserts
    // below never depend on RETURNING order
    const insertsInOrder = order.filter((s): s is { insert: Insert } => 'insert' in s).map((s) => s.insert);
    const insertId = new Map<Insert, string>();
    for (const ins of insertsInOrder) insertId.set(ins, randomUUID());

    for (let i = 0; i < insertsInOrder.length; i += BATCH) {
      const batch = insertsInOrder.slice(i, i + BATCH);
      await tx.insert(chapters).values(batch.map((ins) => ({
        id: insertId.get(ins)!,
        workId: targetWorkId,
        labelRaw: ins.labelRaw,
        editorialPosition: 0, // rewritten by the set-based renumber below
      })));
      await tx.insert(chapterRevisions).values(batch.map((ins) => ({
        chapterId: insertId.get(ins)!,
        title: ins.title,
        contentKey: ins.contentKey,
        bodyCompareHash: ins.bodyHash,
        revisionHash: createHash('sha256')
          .update(`${ins.title}\n${ins.bodyHash}\n${job.processorVersion}`)
          .digest('hex'),
        processorVersion: job.processorVersion,
        sourceImportId: jobId,
      })));
    }

    // overwrite: new immutable revisions for matched-but-changed chapters.
    // chapter_id never changes (ADR-03); head_revision_id moves forward.
    const revisionChanges: { chapterId: string; previousHeadRevisionId: string | null; newRevisionId: string }[] = [];
    for (const up of updates) {
      const revId = randomUUID();
      revisionChanges.push({ chapterId: up.chapterId, previousHeadRevisionId: up.previousHeadRevisionId, newRevisionId: revId });
    }
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      await tx.insert(chapterRevisions).values(batch.map((up, j) => ({
        id: revisionChanges[i + j].newRevisionId,
        chapterId: up.chapterId,
        title: up.title,
        contentKey: up.contentKey,
        bodyCompareHash: up.bodyHash,
        revisionHash: createHash('sha256')
          .update(`${up.title}\n${up.bodyHash}\n${job.processorVersion}`)
          .digest('hex'),
        processorVersion: job.processorVersion,
        sourceImportId: jobId,
      })));
    }
    if (revisionChanges.length > 0) {
      await tx.execute(sql`
        update app.chapters c set head_revision_id = v.rev
        from unnest(${sql.param(revisionChanges.map((r) => r.chapterId))}::uuid[],
                    ${sql.param(revisionChanges.map((r) => r.newRevisionId))}::uuid[]) as v(id, rev)
        where c.id = v.id`);
    }

    // renumber everything to the merged order in one set-based statement; the
    // DEFERRABLE unique tolerates transient duplicates inside the tx
    const finalIds: string[] = [];
    const finalPos: number[] = [];
    for (let i = 0; i < order.length; i++) {
      const slot = order[i];
      finalIds.push('chapterId' in slot ? slot.chapterId : insertId.get(slot.insert)!);
      finalPos.push(i + 1);
    }
    // sql.param: one array parameter each — a bare JS array in a sql`` template
    // would expand into a parameter-list tuple and break the unnest cast
    await tx.execute(sql`
      update app.chapters c set editorial_position = v.pos
      from unnest(${sql.param(finalIds)}::uuid[], ${sql.param(finalPos)}::int[]) as v(id, pos)
      where c.id = v.id`);

    // wire head_revision_id for the new chapters (exactly one revision each)
    const newIds = [...insertId.values()];
    await tx.execute(sql`
      update app.chapters c set head_revision_id = r.id
      from app.chapter_revisions r
      where r.chapter_id = c.id and c.id = any(${sql.param(newIds)}::uuid[])`);

    assertTransition(job.status, 'applied');
    const newEditVersion = work.editVersion + 1;
    await tx.update(works).set({ editVersion: newEditVersion, updatedAt: new Date() })
      .where(eq(works.id, job.workId));

    const summary = {
      added: inserts.length,
      updated: updates.length,
      unchanged,
      modifiedKept,
      skipped: skipped.length,
      missingKept: result.missingFromSource.length,
    };
    // revert snapshot (§12): exactly what this apply created, so the protected
    // revert can undo it without touching anyone else's later edits
    const applied: AppliedSnapshot = {
      workId: job.workId, newEditVersion, summary, mode,
      addedChapterIds: [...insertId.values()],
      revisionChanges,
    };
    await tx.update(importJobs).set({
      status: 'applied',
      applyMode: mode,
      appliedResult: applied,
      completedAt: new Date(),
    }).where(eq(importJobs.id, jobId));

    const response = { ok: true as const, status: 200 as const, workId: job.workId, newEditVersion, summary, alreadyApplied: false };
    if (req.idempotencyKey) {
      await tx.insert(applyIdempotency).values({
        key: req.idempotencyKey, importJobId: jobId, requestHash, response,
      });
    }
    return response;
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
