// Reader routes (M5): read-only canonical content for the production reader.
// Small stable DTOs — never storage keys, import fields, or admin audit data
// (§27). Visibility (M5, ADR-07): draft works are admin preview only;
// public/unlisted are readable by anyone. Publishing flow itself is M6.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { chapters, chapterRevisions, works } from '../db/schema.ts';
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

// removed → 404 like it never existed; draft → admin preview only (403);
// public/unlisted → anyone. Returns the work row or a code to map to a status.
export async function visibleWork(db: NodePgDatabase, id: string, role: string):
  Promise<{ ok: true; work: ReaderWork } | { ok: false; error: 'work_not_found' | 'forbidden' }> {
  const [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
  if (!work || work.visibility === 'removed') return { ok: false, error: 'work_not_found' };
  if (work.visibility === 'draft' && role !== 'admin') return { ok: false, error: 'forbidden' };
  return { ok: true, work };
}

const routeId = (c: Context): string => c.req.param('id') as string;

export function readerRoutes(deps: ReaderRoutesDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db, storage } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  app.get('/api/reader/works/:id', async (c) => {
    const id = routeId(c);
    if (!UUID_RE.test(id)) return c.json({ error: 'work_not_found' }, 404);
    const v = await visibleWork(db, id, c.get('role') ?? '');
    if (!v.ok) return c.json({ error: v.error }, v.error === 'forbidden' ? 403 : 404);
    const work = v.work;
    const [counts] = await db.select({
      n: sql<number>`count(*)::int`,
    }).from(chapters).where(eq(chapters.workId, id));
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
    });
  });

  // ordered TOC, paginated — a 5,000-chapter book never returns all bodies
  app.get('/api/reader/works/:id/chapters', async (c) => {
    const id = routeId(c);
    if (!UUID_RE.test(id)) return c.json({ error: 'work_not_found' }, 404);
    const v = await visibleWork(db, id, c.get('role') ?? '');
    if (!v.ok) return c.json({ error: v.error }, v.error === 'forbidden' ? 403 : 404);
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200) || 200));
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
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
  });

  // current head revision only — historical revisions are admin territory
  app.get('/api/reader/chapters/:id', async (c) => {
    const id = routeId(c);
    if (!UUID_RE.test(id)) return c.json({ error: 'chapter_not_found' }, 404);
    const rows = await db.select({
      chapter: chapters,
      revision: chapterRevisions,
    }).from(chapters)
      .leftJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
      .where(eq(chapters.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: 'chapter_not_found' }, 404);
    const v = await visibleWork(db, row.chapter.workId, c.get('role') ?? '');
    if (!v.ok) return c.json({ error: v.error }, v.error === 'forbidden' ? 403 : 404);
    if (!row.revision) return c.json({ error: 'content_unavailable' }, 409);

    const [neighbors] = await db.select({
      prev: sql<string | null>`(
        select c2.id from app.chapters c2
        where c2.work_id = ${row.chapter.workId} and c2.editorial_position < ${row.chapter.editorialPosition}
        order by c2.editorial_position desc limit 1)`,
      next: sql<string | null>`(
        select c2.id from app.chapters c2
        where c2.work_id = ${row.chapter.workId} and c2.editorial_position > ${row.chapter.editorialPosition}
        order by c2.editorial_position asc limit 1)`,
    }).from(chapters).where(eq(chapters.id, id)).limit(1);

    let body = '';
    try {
      body = (await storage.get(row.revision.contentKey)).toString('utf8');
    } catch {
      // immutable object missing is a server-side integrity problem, not a 404
      return c.json({ error: 'content_unavailable' }, 409);
    }

    return c.json({
      chapterId: row.chapter.id,
      workId: row.chapter.workId,
      revisionId: row.revision.id,
      labelRaw: row.chapter.labelRaw,
      title: row.revision.title,
      body,
      previousChapterId: neighbors.prev,
      nextChapterId: neighbors.next,
      paragraphCount: splitParagraphs(body).length,
      updatedAt: row.revision.createdAt.toISOString(),
    });
  });

  return app;
}
