// Editorial chapter operations. Every content edit creates an immutable
// chapter revision; published releases continue to point at their frozen rows.
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { isNull, and, asc, eq, gt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  bookmarks, chapters, chapterRevisionResources, chapterRevisions,
  readingProgress, userChapterReads, workReleases, works,
} from '../db/schema.ts';
import type { Storage } from '../storage.ts';
import { parseBlocks } from '../import/blocks.ts';
import { revisionHash, type StagedResourceLink } from '../import/resources.ts';

export interface AdminChapterDeps {
  db: NodePgDatabase;
  storage: Storage;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// JSON escaping can roughly double the request body. Stay inside the API's
// configurable 8 MiB request limit even for newline-heavy chapter text.
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const EDITOR_PROCESSOR_VERSION = 'editorial-1';
type ResourceLink = StagedResourceLink & { resourceId: string };

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const validId = (value: string) => UUID_RE.test(value);

function bodyText(value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const normalized = value.replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_BODY_BYTES || !normalized.trim()) return null;
  return normalized;
}

function chapterFields(value: unknown): { labelRaw: string; title: string } | null {
  const row = value as { labelRaw?: unknown; title?: unknown } | null;
  if (!row || typeof row.labelRaw !== 'string' || typeof row.title !== 'string') return null;
  if (row.labelRaw.length > 300 || row.title.length > 300) return null;
  if (!row.labelRaw.trim() && !row.title.trim()) return null;
  return { labelRaw: row.labelRaw.trim(), title: row.title.trim() };
}

function selectLinks(body: string, candidates: readonly ResourceLink[]): { links: ResourceLink[]; missing: string[] } {
  const byHash = new Map(candidates.map((link) => [link.contentHash, link]));
  const used = new Set<string>();
  const missing = new Set<string>();
  for (const block of parseBlocks(body)) {
    if (block.kind !== 'image') continue;
    const source = byHash.get(block.contentHash);
    if (!source) { missing.add(block.contentHash); continue; }
    if (!used.has(block.contentHash)) used.add(block.contentHash);
  }
  return {
    links: [...used].flatMap((hash) => {
      const link = byHash.get(hash);
      return link ? [link] : [];
    }),
    missing: [...missing],
  };
}

async function revisionLinks(db: NodePgDatabase, revisionIds: readonly string[]): Promise<ResourceLink[]> {
  if (revisionIds.length === 0) return [];
  const rows = await db.select({
    resourceId: chapterRevisionResources.resourceId,
    contentHash: chapterRevisionResources.contentHash,
    sourceHref: chapterRevisionResources.sourceHref,
    alt: chapterRevisionResources.alt,
  }).from(chapterRevisionResources)
    .where(sql`${chapterRevisionResources.revisionId} = any(${sql.param([...revisionIds])}::uuid[])`);
  return rows;
}

async function writeRevision(
  tx: Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0],
  storage: Storage,
  chapterId: string,
  title: string,
  body: string,
  links: readonly ResourceLink[],
  writtenKeys: string[],
): Promise<string> {
  const contentKey = await storage.put(Buffer.from(body, 'utf8'), 'txt');
  writtenKeys.push(contentKey);
  const bodyCompareHash = digest(body);
  const [revision] = await tx.insert(chapterRevisions).values({
    chapterId,
    title,
    contentKey,
    bodyCompareHash,
    revisionHash: revisionHash({
      title, bodyCompareHash, processorVersion: EDITOR_PROCESSOR_VERSION,
      resourceLinks: links,
    }),
    processorVersion: EDITOR_PROCESSOR_VERSION,
    sourceImportId: null,
  }).returning({ id: chapterRevisions.id });

  if (links.length > 0) {
    await tx.insert(chapterRevisionResources).values(links.map((link) => ({
      revisionId: revision.id,
      resourceId: link.resourceId,
      contentHash: link.contentHash,
      sourceHref: link.sourceHref,
      alt: link.alt,
    })));
  }
  return revision.id;
}

async function readRevision(
  db: NodePgDatabase,
  storage: Storage,
  chapterId: string,
  revisionId: string,
) {
  const [row] = await db.select({
    id: chapterRevisions.id,
    chapterId: chapterRevisions.chapterId,
    title: chapterRevisions.title,
    contentKey: chapterRevisions.contentKey,
    createdAt: chapterRevisions.createdAt,
    sourceImportId: chapterRevisions.sourceImportId,
  }).from(chapterRevisions).where(and(
    eq(chapterRevisions.id, revisionId), eq(chapterRevisions.chapterId, chapterId),
  )).limit(1);
  if (!row) return null;
  try {
    return { ...row, body: (await storage.get(row.contentKey)).toString('utf8') };
  } catch {
    return null;
  }
}

export function adminChapterRoutes(deps: AdminChapterDeps): Hono {
  const { db, storage } = deps;
  const app = new Hono();
  const base = '/api/admin/chapter-editor/works/:workId/chapters';

  app.delete(`${base}/:chapterId`, async (c) => {
    const { workId, chapterId } = c.req.param();
    if (!validId(workId) || !validId(chapterId)) return c.json({ error: 'chapter_not_found' }, 404);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!validId(String(body?.expectedRevisionId ?? ''))) return c.json({ error: 'invalid_chapter_edit' }, 400);
    const result = await db.transaction(async (tx) => {
      const [work] = await tx.select({ id: works.id }).from(works).where(and(
        eq(works.id, workId), sql`${works.visibility} <> 'removed'`,
      )).for('update').limit(1);
      if (!work) return { status: 404 as const, error: 'work_not_found' };
      const [chapter] = await tx.select().from(chapters).where(and(
        eq(chapters.id, chapterId), eq(chapters.workId, workId),
        isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt),
      )).for('update').limit(1);
      if (!chapter) return { status: 404 as const, error: 'chapter_not_found' };
      if (chapter.headRevisionId !== body!.expectedRevisionId) return { status: 409 as const, error: 'stale_chapter_revision' };
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(chapters).where(and(
        eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt),
      ));
      if (n <= 1) return { status: 409 as const, error: 'last_chapter_cannot_delete' };
      await tx.update(chapters).set({ deletedAt: new Date() }).where(eq(chapters.id, chapterId));
      await tx.update(works).set({ updatedAt: new Date(), editVersion: sql`${works.editVersion} + 1` }).where(eq(works.id, workId));
      return { status: 200 as const, ok: true, chapterId };
    });
    return c.json(result, result.status);
  });

  app.get('/api/admin/chapter-editor/works/:workId/chapters', async (c) => {
    const workId = c.req.param('workId');
    if (!validId(workId)) return c.json({ error: 'work_not_found' }, 404);
    const [work] = await db.select({ id: works.id }).from(works).where(eq(works.id, workId)).limit(1);
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    const rows = await db.select({
      id: chapters.id,
      labelRaw: chapters.labelRaw,
      editorialPosition: chapters.editorialPosition,
      revisionId: chapters.headRevisionId,
      title: chapterRevisions.title,
      createdAt: chapterRevisions.createdAt,
    }).from(chapters)
      .leftJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
      .where(and(eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt)))
      .orderBy(asc(chapters.editorialPosition));
    return c.json({ chapters: rows });
  });

  app.get(`${base}/:chapterId`, async (c) => {
    const { workId, chapterId } = c.req.param();
    if (!validId(workId) || !validId(chapterId)) return c.json({ error: 'chapter_not_found' }, 404);
    const [chapter] = await db.select().from(chapters).where(and(
      eq(chapters.id, chapterId), eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt),
    )).limit(1);
    if (!chapter) return c.json({ error: 'chapter_not_found' }, 404);
    if (!chapter.headRevisionId) return c.json({ error: 'chapter_missing_revision' }, 409);
    const current = await readRevision(db, storage, chapterId, chapter.headRevisionId);
    if (!current) return c.json({ error: 'content_unavailable' }, 409);
    const history = await db.select({
      revisionId: chapterRevisions.id,
      title: chapterRevisions.title,
      createdAt: chapterRevisions.createdAt,
      sourceImportId: chapterRevisions.sourceImportId,
    }).from(chapterRevisions).where(eq(chapterRevisions.chapterId, chapterId))
      .orderBy(sql`${chapterRevisions.createdAt} desc`).limit(100);
    return c.json({
      chapterId, workId, labelRaw: chapter.labelRaw,
      revisionId: current.id, title: current.title, body: current.body,
      updatedAt: current.createdAt.toISOString(), history,
    });
  });

  // Inspecting an older immutable revision is read-only. Saving always creates
  // a new revision on the current head rather than rewriting history.
  app.get(`${base}/:chapterId/revisions/:revisionId`, async (c) => {
    const { workId, chapterId, revisionId } = c.req.param();
    if (![workId, chapterId, revisionId].every(validId)) return c.json({ error: 'revision_not_found' }, 404);
    const [chapter] = await db.select({ id: chapters.id }).from(chapters).where(and(
      eq(chapters.id, chapterId), eq(chapters.workId, workId),
    )).limit(1);
    if (!chapter) return c.json({ error: 'revision_not_found' }, 404);
    const revision = await readRevision(db, storage, chapterId, revisionId);
    if (!revision) return c.json({ error: 'revision_not_found' }, 404);
    return c.json({ revisionId, title: revision.title, body: revision.body, createdAt: revision.createdAt.toISOString() });
  });

  app.patch(`${base}/:chapterId`, async (c) => {
    const { workId, chapterId } = c.req.param();
    if (!validId(workId) || !validId(chapterId)) return c.json({ error: 'chapter_not_found' }, 404);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const fields = chapterFields(body);
    const content = bodyText(body?.body);
    if (!fields || content === null || !validId(String(body?.expectedRevisionId ?? ''))) {
      return c.json({ error: 'invalid_chapter_edit' }, 400);
    }
    const expectedRevisionId = String(body!.expectedRevisionId);
    const writtenKeys: string[] = [];
    try {
      const result = await db.transaction(async (tx) => {
        const [work] = await tx.select({ id: works.id }).from(works).where(eq(works.id, workId)).for('update').limit(1);
        if (!work) return { status: 404 as const, error: 'work_not_found' };
        const [chapter] = await tx.select().from(chapters).where(and(
          eq(chapters.id, chapterId), eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt),
        )).for('update').limit(1);
        if (!chapter) return { status: 404 as const, error: 'chapter_not_found' };
        if (!chapter.headRevisionId) return { status: 409 as const, error: 'chapter_missing_revision' };
        if (chapter.headRevisionId !== expectedRevisionId) return { status: 409 as const, error: 'stale_chapter_revision' };
        const [oldRevision] = await tx.select().from(chapterRevisions)
          .where(eq(chapterRevisions.id, chapter.headRevisionId)).limit(1);
        if (!oldRevision) return { status: 409 as const, error: 'chapter_missing_revision' };
        const oldBody = (await storage.get(oldRevision.contentKey)).toString('utf8');
        if (fields.labelRaw === chapter.labelRaw && fields.title === oldRevision.title && content === oldBody) {
          return { status: 200 as const, ok: true as const, revisionId: oldRevision.id, unchanged: true };
        }
        const availableLinks = await revisionLinks(tx as unknown as NodePgDatabase, [oldRevision.id]);
        const selected = selectLinks(content, availableLinks);
        if (selected.missing.length) return { status: 400 as const, error: 'unknown_content_reference' };
        const revisionId = await writeRevision(tx, storage, chapterId, fields.title, content, selected.links, writtenKeys);
        await tx.update(chapters).set({ labelRaw: fields.labelRaw, headRevisionId: revisionId }).where(eq(chapters.id, chapterId));
        await tx.update(works).set({ updatedAt: new Date(), editVersion: sql`${works.editVersion} + 1` }).where(eq(works.id, workId));
        return { status: 200 as const, ok: true as const, revisionId, unchanged: false };
      });
      return c.json(result, result.status);
    } catch (error) {
      await Promise.allSettled(writtenKeys.map((key) => storage.delete(key)));
      throw error;
    }
  });

  app.post(`${base}/:chapterId/split`, async (c) => {
    const { workId, chapterId } = c.req.param();
    if (!validId(workId) || !validId(chapterId)) return c.json({ error: 'chapter_not_found' }, 404);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const splitAt = body?.afterParagraph;
    const rightLabelRaw = typeof body?.rightLabelRaw === 'string' ? body.rightLabelRaw.trim() : '';
    const rightTitle = typeof body?.rightTitle === 'string' ? body.rightTitle.trim() : '';
    if (!validId(String(body?.expectedRevisionId ?? '')) || !Number.isInteger(splitAt)
      || !rightLabelRaw || rightLabelRaw.length > 300 || rightTitle.length > 300
      || Buffer.byteLength(rightLabelRaw + rightTitle, 'utf8') > 1200) {
      return c.json({ error: 'invalid_chapter_split' }, 400);
    }
    const expectedRevisionId = String(body!.expectedRevisionId);
    const writtenKeys: string[] = [];
    try {
      const result = await db.transaction(async (tx) => {
        const [work] = await tx.select({ id: works.id }).from(works).where(eq(works.id, workId)).for('update').limit(1);
        if (!work) return { status: 404 as const, error: 'work_not_found' };
        const [chapter] = await tx.select().from(chapters).where(and(
          eq(chapters.id, chapterId), eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt),
        )).for('update').limit(1);
        if (!chapter) return { status: 404 as const, error: 'chapter_not_found' };
        if (!chapter.headRevisionId) return { status: 409 as const, error: 'chapter_missing_revision' };
        if (chapter.headRevisionId !== expectedRevisionId) return { status: 409 as const, error: 'stale_chapter_revision' };
        const [oldRevision] = await tx.select().from(chapterRevisions)
          .where(eq(chapterRevisions.id, chapter.headRevisionId)).limit(1);
        if (!oldRevision) return { status: 409 as const, error: 'chapter_missing_revision' };
        const oldBody = (await storage.get(oldRevision.contentKey)).toString('utf8');
        const paragraphs = oldBody.split('\n\n');
        if ((splitAt as number) < 1 || (splitAt as number) >= paragraphs.length) {
          return { status: 400 as const, error: 'invalid_split_position' };
        }
        const leftBody = paragraphs.slice(0, splitAt as number).join('\n\n');
        const rightBody = paragraphs.slice(splitAt as number).join('\n\n');
        const availableLinks = await revisionLinks(tx as unknown as NodePgDatabase, [oldRevision.id]);
        const leftSelection = selectLinks(leftBody, availableLinks);
        const rightSelection = selectLinks(rightBody, availableLinks);
        if (leftSelection.missing.length || rightSelection.missing.length) {
          return { status: 409 as const, error: 'content_reference_unavailable' };
        }
        await tx.execute(sql`set constraints app.chapters_work_position_uq deferred`);
        await tx.update(chapters).set({ editorialPosition: sql`${chapters.editorialPosition} + 1` })
          .where(and(eq(chapters.workId, workId), gt(chapters.editorialPosition, chapter.editorialPosition)));
        const [newChapter] = await tx.insert(chapters).values({
          workId, volumeId: chapter.volumeId, labelRaw: rightLabelRaw,
          editorialPosition: chapter.editorialPosition + 1,
        }).returning({ id: chapters.id });
        const leftRevisionId = await writeRevision(tx, storage, chapterId, oldRevision.title,
          leftBody, leftSelection.links, writtenKeys);
        const rightRevisionId = await writeRevision(tx, storage, newChapter.id, rightTitle,
          rightBody, rightSelection.links, writtenKeys);
        await tx.update(chapters).set({ headRevisionId: leftRevisionId }).where(eq(chapters.id, chapterId));
        await tx.update(chapters).set({ headRevisionId: rightRevisionId }).where(eq(chapters.id, newChapter.id));
        await tx.update(works).set({ updatedAt: new Date(), editVersion: sql`${works.editVersion} + 1` }).where(eq(works.id, workId));
        return { status: 200 as const, ok: true as const, chapterId: newChapter.id, leftRevisionId, rightRevisionId };
      });
      return c.json(result, result.status);
    } catch (error) {
      await Promise.allSettled(writtenKeys.map((key) => storage.delete(key)));
      throw error;
    }
  });

  app.post(`${base}/:chapterId/merge-next`, async (c) => {
    const { workId, chapterId } = c.req.param();
    if (!validId(workId) || !validId(chapterId)) return c.json({ error: 'chapter_not_found' }, 404);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const nextChapterId = body?.nextChapterId;
    const fields = chapterFields({ labelRaw: body?.labelRaw, title: body?.title });
    if (!validId(String(body?.expectedRevisionId ?? '')) || typeof nextChapterId !== 'string'
      || !validId(nextChapterId) || !validId(String(body?.expectedNextRevisionId ?? '')) || !fields) {
      return c.json({ error: 'invalid_chapter_merge' }, 400);
    }
    const expectedRevisionId = String(body!.expectedRevisionId);
    const expectedNextRevisionId = String(body!.expectedNextRevisionId);
    const writtenKeys: string[] = [];
    try {
      const result = await db.transaction(async (tx) => {
        const [work] = await tx.select({ id: works.id }).from(works).where(eq(works.id, workId)).for('update').limit(1);
        if (!work) return { status: 404 as const, error: 'work_not_found' };
        // Past releases are immutable snapshots which still refer to both
        // chapter IDs. Keep the merge unavailable while that history exists.
        const [release] = await tx.select({ id: workReleases.id }).from(workReleases)
          .where(eq(workReleases.workId, workId)).limit(1);
        if (release) return { status: 409 as const, error: 'published_chapters_cannot_merge' };
        const chapterIds = [chapterId, nextChapterId].sort();
        const locked = await tx.select().from(chapters).where(and(
          eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt), sql`${chapters.id} = any(${sql.param(chapterIds)}::uuid[])`,
        )).orderBy(asc(chapters.id)).for('update');
        const first = locked.find((row) => row.id === chapterId);
        const next = locked.find((row) => row.id === nextChapterId);
        if (!first || !next) return { status: 404 as const, error: 'chapter_not_found' };
        if (!first.headRevisionId || !next.headRevisionId) return { status: 409 as const, error: 'chapter_missing_revision' };
        if (first.headRevisionId !== expectedRevisionId || next.headRevisionId !== expectedNextRevisionId) {
          return { status: 409 as const, error: 'stale_chapter_revision' };
        }
        const [adjacent] = await tx.select({ id: chapters.id }).from(chapters).where(and(
          eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt),
          gt(chapters.editorialPosition, first.editorialPosition),
        )).orderBy(asc(chapters.editorialPosition)).limit(1);
        if (adjacent?.id !== nextChapterId || next.volumeId !== first.volumeId) {
          return { status: 409 as const, error: 'chapters_not_adjacent' };
        }
        // Absorbing a previous survivor would create a tombstone chain.
        const [incomingMerge] = await tx.select({ id: chapters.id }).from(chapters)
          .where(eq(chapters.mergedIntoChapterId, nextChapterId)).limit(1);
        if (incomingMerge) return { status: 409 as const, error: 'chapter_is_merge_target' };
        const [bookmark] = await tx.select({ id: bookmarks.id }).from(bookmarks)
          .where(eq(bookmarks.chapterId, nextChapterId)).limit(1);
        const [read] = await tx.select({ userId: userChapterReads.userId }).from(userChapterReads)
          .where(eq(userChapterReads.chapterId, nextChapterId)).limit(1);
        const [progress] = await tx.select({ userId: readingProgress.userId }).from(readingProgress)
          .where(and(eq(readingProgress.workId, workId), eq(readingProgress.chapterId, nextChapterId))).limit(1);
        if (bookmark || read || progress) return { status: 409 as const, error: 'chapter_has_reader_references' };

        const [firstRevision] = await tx.select().from(chapterRevisions)
          .where(eq(chapterRevisions.id, first.headRevisionId)).limit(1);
        const [nextRevision] = await tx.select().from(chapterRevisions)
          .where(eq(chapterRevisions.id, next.headRevisionId)).limit(1);
        if (!firstRevision || !nextRevision) return { status: 409 as const, error: 'chapter_missing_revision' };
        const firstBody = (await storage.get(firstRevision.contentKey)).toString('utf8');
        const nextBody = (await storage.get(nextRevision.contentKey)).toString('utf8');
        const mergedBody = firstBody && nextBody ? `${firstBody}\n\n${nextBody}` : firstBody || nextBody;
        if (Buffer.byteLength(mergedBody, 'utf8') > MAX_BODY_BYTES) return { status: 413 as const, error: 'merged_content_too_large' };
        const candidates = await revisionLinks(tx as unknown as NodePgDatabase, [firstRevision.id, nextRevision.id]);
        const selected = selectLinks(mergedBody, candidates);
        if (selected.missing.length) return { status: 409 as const, error: 'content_reference_unavailable' };

        const newRevisionId = await writeRevision(tx, storage, chapterId, fields.title, mergedBody, selected.links, writtenKeys);
        // Retain the absorbed row, original head, revisions and position.
        await tx.update(chapters).set({ mergedIntoChapterId: chapterId }).where(eq(chapters.id, nextChapterId));
        await tx.update(chapters).set({ labelRaw: fields.labelRaw, headRevisionId: newRevisionId }).where(eq(chapters.id, chapterId));
        await tx.update(works).set({ updatedAt: new Date(), editVersion: sql`${works.editVersion} + 1` }).where(eq(works.id, workId));
        return { status: 200 as const, ok: true as const, chapterId, revisionId: newRevisionId };
      });
      return c.json(result, result.status);
    } catch (error) {
      await Promise.allSettled(writtenKeys.map((key) => storage.delete(key)));
      throw error;
    }
  });

  return app;
}
