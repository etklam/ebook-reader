// Publication (M6, dev-plan §13): an explicit Admin operation that snapshots
// the editorial head into an immutable release and atomically switches the
// public active_release pointer. Editorial imports never change public content
// until this runs. Retry-safe: the same Idempotency-Key (or an unchanged
// editorial head) returns the existing release without creating anything.
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  categories, chapterRevisions, chapters, publicationEvents, releaseItems, works,
  workCategories, workReleases,
} from '../db/schema.ts';
import type { Storage } from '../storage.ts';

export interface PublishRequest {
  createdByUserId: string;
  note?: string;
  idempotencyKey?: string | null;
}

export interface ReleaseDiff {
  newChapterIds: string[];
  updatedChapterIds: string[];
  reorderedChapterIds: string[];
}

export type PublishPreview =
  | {
      ok: true; workId: string;
      valid: boolean; problems: string[];
      chapterCount: number;
      previousRelease: { id: string; version: number; chapterCount: number } | null;
      diff: ReleaseDiff;
    }
  | { ok: false; status: 404; error: string };

export type PublishResult =
  | {
      ok: true; status: 200; workId: string; releaseId: string; version: number;
      chapterCount: number; diff: ReleaseDiff; alreadyPublished: boolean;
    }
  | { ok: false; status: 400 | 404 | 409; error: string; detail?: string; problems?: string[] };

// loaded release items in editorial order — the comparison unit between releases
interface SnapItem { chapterId: string; revisionId: string; position: number }

interface ReleaseSnapshot {
  revisions: Map<string, string>;   // chapterId → revisionId
  positions: Map<string, number>;   // chapterId → editorial position
}

function classify(current: SnapItem[], previous: ReleaseSnapshot | null): ReleaseDiff {
  const diff: ReleaseDiff = { newChapterIds: [], updatedChapterIds: [], reorderedChapterIds: [] };
  if (!previous) return { ...diff, newChapterIds: current.map((c) => c.chapterId) };
  for (const item of current) {
    const prevRev = previous.revisions.get(item.chapterId);
    if (prevRev === undefined) {
      diff.newChapterIds.push(item.chapterId);
    } else if (prevRev !== item.revisionId) {
      diff.updatedChapterIds.push(item.chapterId);
    } else if (previous.positions.get(item.chapterId) !== item.position) {
      diff.reorderedChapterIds.push(item.chapterId);
    }
  }
  return diff;
}

async function loadSnapshot(db: NodePgDatabase, releaseId: string): Promise<ReleaseSnapshot> {
  const rows = await db.select({
    chapterId: releaseItems.chapterId,
    revisionId: releaseItems.revisionId,
    position: releaseItems.editorialPosition,
  }).from(releaseItems).where(eq(releaseItems.releaseId, releaseId)).orderBy(asc(releaseItems.editorialPosition));
  const snap: ReleaseSnapshot = { revisions: new Map(), positions: new Map() };
  for (const r of rows) {
    snap.revisions.set(r.chapterId, r.revisionId);
    snap.positions.set(r.chapterId, r.position);
  }
  return snap;
}

// publication metadata gates (§6). Draft works may stay uncategorized; the
// FIRST publish requires at least one active category. Tags stay optional.
export async function validateForPublish(
  db: NodePgDatabase, storage: Storage, workId: string,
): Promise<{ valid: boolean; problems: string[] }> {
  const problems: string[] = [];
  const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
  if (!work) return { valid: false, problems: ['work_not_found'] };
  if (!work.title.trim()) problems.push('title_required');
  if (work.workType !== 'short_story' && work.workType !== 'serial') problems.push('invalid_work_type');
  if (work.workType === 'serial' && !work.serialStatus) problems.push('serial_status_required');
  if (work.visibility === 'removed') problems.push('work_removed');

  const chapterRows = await db.select({
    id: chapters.id,
    headRevisionId: chapters.headRevisionId,
    contentKey: chapterRevisions.contentKey,
  }).from(chapters)
    .leftJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
    .where(eq(chapters.workId, workId))
    .orderBy(asc(chapters.editorialPosition));
  if (chapterRows.length === 0) problems.push('no_chapters');
  const missingRevision = chapterRows.filter((c) => !c.headRevisionId).length;
  if (missingRevision > 0) problems.push(`${missingRevision}_chapters_missing_revision`);

  // content object existence: cheap stat, bodies are never read here
  const keys = chapterRows.map((c) => c.contentKey).filter((k): k is string => Boolean(k));
  const missing = (await Promise.all(keys.map(async (k) => (await storage.exists(k) ? null : k)))).filter(Boolean);
  if (missing.length > 0) problems.push(`${missing.length}_content_objects_missing`);

  const [cats] = await db.select({ n: sql<number>`count(*)::int` })
    .from(workCategories)
    .innerJoin(categories, eq(categories.id, workCategories.categoryId))
    .where(sql`${workCategories.workId} = ${workId} and ${categories.isActive}`);
  if (cats.n === 0) problems.push('category_required_for_first_publication');

  return { valid: problems.length === 0, problems };
}

async function editorialSnapshot(db: NodePgDatabase, workId: string): Promise<SnapItem[]> {
  const rows = await db.select({
    chapterId: chapters.id,
    revisionId: chapters.headRevisionId,
    position: chapters.editorialPosition,
  }).from(chapters).where(eq(chapters.workId, workId)).orderBy(asc(chapters.editorialPosition));
  // head is guaranteed non-null by validation before this runs
  return rows.map((r) => ({ chapterId: r.chapterId, revisionId: r.revisionId!, position: r.position }));
}

export async function publishPreview(db: NodePgDatabase, storage: Storage, workId: string): Promise<PublishPreview> {
  const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
  if (!work) return { ok: false, status: 404, error: 'work_not_found' };
  const validation = await validateForPublish(db, storage, workId);
  const [prevRelease] = await db.select({
    id: workReleases.id, version: workReleases.version, chapterCount: workReleases.chapterCount,
  }).from(workReleases).where(eq(workReleases.workId, workId))
    .orderBy(sql`${workReleases.version} desc`).limit(1);
  const current = await editorialSnapshot(db, workId);
  const diff = prevRelease
    ? classify(current, await loadSnapshot(db, prevRelease.id))
    : { newChapterIds: current.map((c) => c.chapterId), updatedChapterIds: [], reorderedChapterIds: [] };
  return {
    ok: true, workId,
    valid: validation.valid,
    problems: validation.problems,
    chapterCount: current.length,
    previousRelease: prevRelease ?? null,
    diff,
  };
}

export async function publishWork(
  db: NodePgDatabase, storage: Storage, workId: string, req: PublishRequest,
): Promise<PublishResult> {
  const key = req.idempotencyKey?.trim() || null;
  if (key !== null && key.length > 200) {
    return { ok: false, status: 400, error: 'invalid_idempotency_key' };
  }

  return db.transaction(async (tx) => {
    // retry replay: same key returns the persisted publication (§61)
    if (key) {
      const [existing] = await tx.select().from(workReleases)
        .where(eq(workReleases.idempotencyKey, key)).limit(1);
      if (existing) {
        if (existing.workId !== workId) {
          return { ok: false, status: 409, error: 'idempotency_conflict', detail: 'key belongs to another work' };
        }
        const diff = await replayDiff(tx, existing.id);
        return {
          ok: true, status: 200, workId, releaseId: existing.id, version: existing.version,
          chapterCount: existing.chapterCount, diff, alreadyPublished: true,
        };
      }
    }

    // 1) lock the work — serializes publishes and blocks concurrent applies
    const workRows = await tx.select().from(works).where(eq(works.id, workId)).for('update').limit(1);
    const work = workRows[0];
    if (!work) return { ok: false, status: 404, error: 'work_not_found' };

    // 2-4) validation gates; on failure the active release stays untouched
    const validation = await validateForPublish(tx as unknown as NodePgDatabase, storage, workId);
    if (!validation.valid) {
      return { ok: false, status: 400, error: 'publish_validation_failed', problems: validation.problems };
    }

    // 5-6) immutable release + exact chapter→revision snapshot
    const [maxVersion] = await tx.select({ v: sql<number>`coalesce(max(${workReleases.version}), 0)::int` })
      .from(workReleases).where(eq(workReleases.workId, workId));
    const version = maxVersion.v + 1;
    const current = await editorialSnapshot(tx as unknown as NodePgDatabase, workId);

    const [release] = await tx.insert(workReleases).values({
      workId,
      version,
      idempotencyKey: key,
      note: (req.note ?? '').slice(0, 500),
      chapterCount: current.length,
      createdByUserId: req.createdByUserId,
    }).returning({ id: workReleases.id });

    // label/title snapshots come from the current head revisions
    const heads = await tx.select({
      id: chapterRevisions.id,
      title: chapterRevisions.title,
    }).from(chapterRevisions)
      .where(inArray(chapterRevisions.id, current.map((c) => c.revisionId)));
    const titleByRevision = new Map(heads.map((h) => [h.id, h.title]));
    const labels = await tx.select({ id: chapters.id, labelRaw: chapters.labelRaw })
      .from(chapters).where(inArray(chapters.id, current.map((c) => c.chapterId)));
    const labelById = new Map(labels.map((l) => [l.id, l.labelRaw]));

    const BATCH = 500;
    for (let i = 0; i < current.length; i += BATCH) {
      await tx.insert(releaseItems).values(
        current.slice(i, i + BATCH).map((c) => ({
          releaseId: release.id,
          chapterId: c.chapterId,
          revisionId: c.revisionId,
          editorialPosition: c.position,
          labelRaw: labelById.get(c.chapterId) ?? '',
          title: titleByRevision.get(c.revisionId) ?? '',
        })),
      );
    }

    // 7-8) publication event + atomic active-release switch
    const diff = work.activeReleaseId
      ? classify(current, await loadSnapshot(tx as unknown as NodePgDatabase, work.activeReleaseId))
      : { newChapterIds: current.map((c) => c.chapterId), updatedChapterIds: [], reorderedChapterIds: [] };
    await tx.insert(publicationEvents).values({
      workId,
      releaseId: release.id,
      releaseVersion: version,
      newChapterIds: diff.newChapterIds,
      updatedChapterIds: diff.updatedChapterIds,
    });
    await tx.update(works).set({ activeReleaseId: release.id, updatedAt: new Date() })
      .where(eq(works.id, workId));

    return {
      ok: true, status: 200, workId, releaseId: release.id, version,
      chapterCount: current.length, diff, alreadyPublished: false,
    };
  });
}

async function replayDiff(
  tx: Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0], releaseId: string,
): Promise<ReleaseDiff> {
  const rows = await tx.select({
    newChapterIds: publicationEvents.newChapterIds,
    updatedChapterIds: publicationEvents.updatedChapterIds,
  }).from(publicationEvents).where(eq(publicationEvents.releaseId, releaseId)).limit(1);
  const event = rows[0];
  return {
    newChapterIds: (event?.newChapterIds as string[]) ?? [],
    updatedChapterIds: (event?.updatedChapterIds as string[]) ?? [],
    reorderedChapterIds: [],
  };
}
