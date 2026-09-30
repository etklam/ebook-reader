// Reader routes (M5→M6): read-only canonical content for the production
// reader. M6 contract: public reading consumes the work's ACTIVE RELEASE
// snapshot (release_items → immutable revisions) — never the editorial head.
// The editorial head is visible only through Admin preview routes or, for
// unpublished draft works, to Admin through these same routes (a draft has no
// release; Admin previewing a published work's head must use /api/admin/preview).
// Visibility: draft = Admin only (403 others); public = listed + readable;
// unlisted = readable by direct URL, never listed; removed = 404.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  chapters, chapterRevisions, releaseItems, works, workReleases,
} from '../db/schema.ts';
import type { Storage } from '../storage.ts';

export interface ReaderRoutesDeps {
  db: NodePgDatabase;
  storage: Storage;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// canonical body is paragraphs joined with \n\n (M2 parser contract)
export function splitParagraphs(body: string): string[] {
  if (body === '') return [];
  return body.split('\n\n');
}

type ReaderWork = typeof works.$inferSelect;

// removed → 404 like it never existed; draft → Admin preview only (403);
// public/unlisted → anyone. Returns the work row or a code to map to a status.
export async function visibleWork(db: NodePgDatabase, id: string, role: string):
  Promise<{ ok: true; work: ReaderWork } | { ok: false; error: 'work_not_found' | 'forbidden' }> {
  const [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
  if (!work || work.visibility === 'removed') return { ok: false, error: 'work_not_found' };
  if (work.visibility === 'draft' && role !== 'admin') return { ok: false, error: 'forbidden' };
  return { ok: true, work };
}

const routeId = (c: Context): string => c.req.param('id') as string;

// which content source applies: a draft work has no release, so Admin preview
// falls back to the editorial head; everything published reads the snapshot
function contentSource(work: ReaderWork, role: string): 'release' | 'head' {
  return work.activeReleaseId && !(work.visibility === 'draft' && role === 'admin') ? 'release' : 'head';
}

export function readerRoutes(deps: ReaderRoutesDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db, storage } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  app.get('/api/reader/works/:id', async (c) => {
    const id = routeId(c);
    if (!UUID_RE.test(id)) return c.json({ error: 'work_not_found' }, 404);
    const v = await visibleWork(db, id, c.get('role') ?? '');
    if (!v.ok) return c.json({ error: v.error }, v.error === 'forbidden' ? 403 : 404);
    const work = v.work;
    const source = contentSource(work, c.get('role') ?? '');

    if (source === 'head') {
      // draft preview: editorial counts (M5 semantics, Admin only)
      const [counts] = await db.select({ n: sql<number>`count(*)::int` })
        .from(chapters).where(eq(chapters.workId, id));
      let firstChapterId: string | null = null;
      let latestChapterId: string | null = null;
      if (counts.n > 0) {
        const ends = await db.select({
          first: sql<string>`(array_agg(${chapters.id} order by ${chapters.editorialPosition} asc))[1]`,
          latest: sql<string>`(array_agg(${chapters.id} order by ${chapters.editorialPosition} desc))[1]`,
        }).from(chapters).where(eq(chapters.workId, id));
        firstChapterId = ends[0].first;
        latestChapterId = ends[0].latest;
      }
      return c.json({
        id: work.id,
        title: work.title,
        author: work.author,
        workType: work.workType,
        serialStatus: work.serialStatus,
        description: work.description,
        visibility: work.visibility,
        chapterCount: counts.n,
        firstChapterId,
        latestChapterId,
        releaseId: null,
        releaseVersion: null,
        publishedAt: null,
      });
    }

    // public/unlisted (and Admin reading a published work): release snapshot
    const [release] = await db.select({
      id: workReleases.id,
      version: workReleases.version,
      chapterCount: workReleases.chapterCount,
      publishedAt: workReleases.publishedAt,
    }).from(workReleases).where(eq(workReleases.id, work.activeReleaseId!)).limit(1);
    const ends = await db.select({
      first: sql<string | null>`(array_agg(${releaseItems.chapterId} order by ${releaseItems.editorialPosition} asc))[1]`,
      latest: sql<string | null>`(array_agg(${releaseItems.chapterId} order by ${releaseItems.editorialPosition} desc))[1]`,
    }).from(releaseItems).where(eq(releaseItems.releaseId, release.id));
    return c.json({
      id: work.id,
      title: work.title,
      author: work.author,
      workType: work.workType,
      serialStatus: work.serialStatus,
      description: work.description,
      visibility: work.visibility,
      chapterCount: release.chapterCount,
      firstChapterId: ends[0].first,
      latestChapterId: ends[0].latest,
      releaseId: release.id,
      releaseVersion: release.version,
      publishedAt: release.publishedAt.toISOString(),
    });
  });

  // ordered TOC, paginated — a 5,000-chapter book never returns all bodies.
  // Public reads get the release's stable order; draft preview gets editorial order.
  app.get('/api/reader/works/:id/chapters', async (c) => {
    const id = routeId(c);
    if (!UUID_RE.test(id)) return c.json({ error: 'work_not_found' }, 404);
    const v = await visibleWork(db, id, c.get('role') ?? '');
    if (!v.ok) return c.json({ error: v.error }, v.error === 'forbidden' ? 403 : 404);
    const work = v.work;
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200) || 200));
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);

    if (contentSource(work, c.get('role') ?? '') === 'head') {
      const [total] = await db.select({ n: sql<number>`count(*)::int` })
        .from(chapters).where(eq(chapters.workId, id));
      const rows = await db.select({
        id: chapters.id,
        volumeId: chapters.volumeId,
        labelRaw: chapters.labelRaw,
        title: chapterRevisions.title,
        editorialPosition: chapters.editorialPosition,
        revisionId: chapters.headRevisionId,
      }).from(chapters)
        .leftJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
        .where(eq(chapters.workId, id))
        .orderBy(asc(chapters.editorialPosition))
        .limit(limit).offset(offset);
      return c.json({ total: total.n, limit, offset, chapters: rows });
    }

    const [total] = await db.select({ n: workReleases.chapterCount })
      .from(workReleases).where(eq(workReleases.id, work.activeReleaseId!));
    const rows = await db.select({
      id: releaseItems.chapterId,
      volumeId: releaseItems.volumeId,
      labelRaw: releaseItems.labelRaw,
      title: releaseItems.title,
      editorialPosition: releaseItems.editorialPosition,
      revisionId: releaseItems.revisionId,
    }).from(releaseItems)
      .where(eq(releaseItems.releaseId, work.activeReleaseId!))
      .orderBy(asc(releaseItems.editorialPosition))
      .limit(limit).offset(offset);
    return c.json({ total: total.n, limit, offset, chapters: rows });
  });

  // chapter content — release snapshot for the public; head only for draft
  // preview (Admin). Head content of a PUBLISHED work belongs to the Admin
  // preview routes, deliberately not here.
  app.get('/api/reader/chapters/:id', async (c) => {
    const id = routeId(c);
    if (!UUID_RE.test(id)) return c.json({ error: 'chapter_not_found' }, 404);
    const rows = await db.select({ chapterId: chapters.id, workId: chapters.workId })
      .from(chapters).where(eq(chapters.id, id)).limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: 'chapter_not_found' }, 404);
    const v = await visibleWork(db, row.workId, c.get('role') ?? '');
    if (!v.ok) return c.json({ error: v.error }, v.error === 'forbidden' ? 403 : 404);
    const work = v.work;
    const source = contentSource(work, c.get('role') ?? '');

    let revisionId: string | null;
    let labelRaw: string;
    let previousChapterId: string | null;
    let nextChapterId: string | null;
    if (source === 'release') {
      const [item] = await db.select({
        revisionId: releaseItems.revisionId,
        labelRaw: releaseItems.labelRaw,
        position: releaseItems.editorialPosition,
      }).from(releaseItems)
        .where(sql`${releaseItems.releaseId} = ${work.activeReleaseId!} and ${releaseItems.chapterId} = ${id}`)
        .limit(1);
      if (!item) return c.json({ error: 'chapter_not_found' }, 404); // not in this release
      const neighbors = await db.select({
        prev: sql<string | null>`(select chapter_id from app.release_items
          where release_id = ${work.activeReleaseId!} and editorial_position < ${item.position}
          order by editorial_position desc limit 1)`,
        next: sql<string | null>`(select chapter_id from app.release_items
          where release_id = ${work.activeReleaseId!} and editorial_position > ${item.position}
          order by editorial_position asc limit 1)`,
      }).from(releaseItems).limit(1);
      revisionId = item.revisionId;
      labelRaw = item.labelRaw;
      previousChapterId = neighbors[0].prev;
      nextChapterId = neighbors[0].next;
    } else {
      const [head] = await db.select({
        headRevisionId: chapters.headRevisionId,
        labelRaw: chapters.labelRaw,
        editorialPosition: chapters.editorialPosition,
      }).from(chapters).where(eq(chapters.id, id)).limit(1);
      if (!head) return c.json({ error: 'chapter_not_found' }, 404);
      const neighbors = await db.select({
        prev: sql<string | null>`(select c2.id from app.chapters c2
          where c2.work_id = ${work.id} and c2.editorial_position < ${head.editorialPosition}
          order by c2.editorial_position desc limit 1)`,
        next: sql<string | null>`(select c2.id from app.chapters c2
          where c2.work_id = ${work.id} and c2.editorial_position > ${head.editorialPosition}
          order by c2.editorial_position asc limit 1)`,
      }).from(chapters).where(eq(chapters.id, id)).limit(1);
      revisionId = head.headRevisionId;
      labelRaw = head.labelRaw;
      previousChapterId = neighbors[0].prev;
      nextChapterId = neighbors[0].next;
    }
    if (!revisionId) return c.json({ error: 'content_unavailable' }, 409);

    const [revision] = await db.select({
      title: chapterRevisions.title,
      contentKey: chapterRevisions.contentKey,
      createdAt: chapterRevisions.createdAt,
    }).from(chapterRevisions).where(eq(chapterRevisions.id, revisionId)).limit(1);
    if (!revision) return c.json({ error: 'content_unavailable' }, 409);

    let body = '';
    try {
      body = (await storage.get(revision.contentKey)).toString('utf8');
    } catch {
      // immutable object missing is a server-side integrity problem, not a 404
      return c.json({ error: 'content_unavailable' }, 409);
    }

    return c.json({
      chapterId: row.chapterId,
      workId: row.workId,
      revisionId,
      labelRaw,
      title: revision.title,
      body,
      previousChapterId,
      nextChapterId,
      paragraphCount: splitParagraphs(body).length,
      updatedAt: revision.createdAt.toISOString(),
    });
  });

  return app;
}
