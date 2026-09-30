// Admin work routes (M6): explicit publication, publish preview, and the
// editorial HEAD preview that never leaks to the public reader. Publish is a
// deliberate operation — import/apply never publishes.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { chapters, chapterRevisions, works, workReleases } from '../db/schema.ts';
import type { Storage } from '../storage.ts';
import { publishPreview, publishWork } from '../publish/publish.ts';

export interface AdminWorksDeps {
  db: NodePgDatabase;
  storage: Storage;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routeId = (c: Context): string => c.req.param('workId') as string;

export function adminWorkRoutes(deps: AdminWorksDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db, storage } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  // GET publish preview: validation problems + diff vs previous release (§49)
  app.get('/api/admin/works/:workId/publish-preview', async (c) => {
    const r = await publishPreview(db, storage, routeId(c));
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json(r);
  });

  // POST publish: locks the work, snapshots the head, atomically switches the
  // public active release. Idempotency-Key replay returns the same release.
  app.post('/api/admin/works/:workId/publish', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const idempotencyKey = c.req.header('idempotency-key')?.trim() || null;
    const result = await publishWork(db, storage, routeId(c), {
      createdByUserId: c.get('userId'),
      note: typeof body?.note === 'string' ? body.note : undefined,
      idempotencyKey,
    });
    if (!result.ok) return c.json(result, result.status);
    const { ok: _ok, status: _status, ...resp } = result;
    return c.json(resp);
  });

  // editorial HEAD preview for published works: never exposed via /api/reader
  app.get('/api/admin/preview/works/:workId/chapters', async (c) => {
    const workId = routeId(c);
    if (!UUID_RE.test(workId)) return c.json({ error: 'work_not_found' }, 404);
    const [work] = await db.select({ id: works.id }).from(works).where(eq(works.id, workId)).limit(1);
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    const rows = await db.select({
      id: chapters.id,
      labelRaw: chapters.labelRaw,
      title: chapterRevisions.title,
      editorialPosition: chapters.editorialPosition,
      revisionId: chapters.headRevisionId,
    }).from(chapters)
      .leftJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
      .where(eq(chapters.workId, workId))
      .orderBy(asc(chapters.editorialPosition));
    const [release] = await db.select({ id: workReleases.id })
      .from(workReleases).where(eq(workReleases.workId, workId))
      .orderBy(sql`${workReleases.version} desc`).limit(1);
    return c.json({ releaseId: release?.id ?? null, chapters: rows });
  });
  app.get('/api/admin/preview/works/:workId/chapters/:chapterId', async (c) => {
    const workId = routeId(c);
    const chapterId = c.req.param('chapterId');
    if (!UUID_RE.test(workId) || !UUID_RE.test(chapterId)) return c.json({ error: 'chapter_not_found' }, 404);
    const rows = await db.select({
      chapterId: chapters.id,
      workId: chapters.workId,
      revisionId: chapters.headRevisionId,
      labelRaw: chapters.labelRaw,
      title: chapterRevisions.title,
      contentKey: chapterRevisions.contentKey,
      createdAt: chapterRevisions.createdAt,
    }).from(chapters)
      .innerJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
      .where(sql`${chapters.id} = ${chapterId} and ${chapters.workId} = ${workId}`)
      .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: 'chapter_not_found' }, 404);
    let body: string;
    try {
      body = (await storage.get(row.contentKey)).toString('utf8');
    } catch {
      return c.json({ error: 'content_unavailable' }, 409);
    }
    return c.json({
      chapterId: row.chapterId,
      workId: row.workId,
      revisionId: row.revisionId,
      labelRaw: row.labelRaw,
      title: row.title,
      body,
      paragraphCount: body === '' ? 0 : body.split('\n\n').length,
      updatedAt: row.createdAt.toISOString(),
    });
  });

  return app;
}
