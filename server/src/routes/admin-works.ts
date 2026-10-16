// Admin work routes (M6): explicit publication, publish preview, editorial
// HEAD preview (never leaked via /api/reader), and taxonomy management
// (categories/tags CRUD + per-work assignment). Publish is a deliberate
// operation — import/apply never publishes.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, isNull, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  categories, chapters, chapterRevisions, tags, workCategories, works, workReleases, workTags,
} from '../db/schema.ts';
import type { Storage } from '../storage.ts';
import { publishPreview, publishWork } from '../publish/publish.ts';
import {
  assignWorkTaxonomy, MAX_CATEGORIES_PER_WORK, MAX_TAGS_PER_WORK, validateTaxonomyIds,
} from '../taxonomy/assign.ts';

export interface AdminWorksDeps {
  db: NodePgDatabase;
  storage: Storage;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routeId = (c: Context): string => c.req.param('workId') as string;

// limits live with the shared assignment helper; re-exported for existing callers
export { MAX_CATEGORIES_PER_WORK, MAX_TAGS_PER_WORK };

export function adminWorkRoutes(deps: AdminWorksDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db, storage } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  app.get('/api/admin/works', async (c) => {
    const query = (c.req.query('q') ?? '').trim().slice(0, 100);
    const literal = query.replace(/[\\%_]/g, '\\$&');
    const rows = await db.select({ id: works.id, title: works.title, author: works.author,
      visibility: works.visibility, activeReleaseId: works.activeReleaseId })
      .from(works).where(query ? or(ilike(works.title, `%${literal}%`), ilike(works.author, `%${literal}%`)) : undefined)
      .orderBy(desc(works.createdAt), desc(works.id)).limit(50);
    return c.json({ works: rows });
  });

  app.patch('/api/admin/works/:workId', async (c) => {
    const workId = routeId(c);
    if (!UUID_RE.test(workId)) return c.json({ error: 'work_not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_work_metadata' }, 400);
    const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    const workType = body.workType === undefined ? work.workType : body.workType;
    if (!['serial', 'short_story'].includes(workType)) return c.json({ error: 'invalid_work_metadata' }, 400);
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 300 ||
      typeof body.author !== 'string' || body.author.length > 300 ||
      typeof body.description !== 'string' || body.description.length > 5000 ||
      (body.serialStatus !== null && !['ongoing', 'completed', 'paused'].includes(body.serialStatus))) {
      return c.json({ error: 'invalid_work_metadata' }, 400);
    }
    await db.update(works).set({ title: body.title.trim(), author: body.author.trim(), workType,
      description: body.description.trim(),
      serialStatus: workType === 'serial' ? body.serialStatus : null,
      updatedAt: new Date(), editVersion: sql`${works.editVersion} + 1`,
    }).where(eq(works.id, workId));
    return c.json({ ok: true });
  });

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
    const [work] = await db.select({ id: works.id, title: works.title, author: works.author,
      description: works.description, serialStatus: works.serialStatus, workType: works.workType }).from(works).where(eq(works.id, workId)).limit(1);
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    const rows = await db.select({
      id: chapters.id,
      labelRaw: chapters.labelRaw,
      title: chapterRevisions.title,
      editorialPosition: chapters.editorialPosition,
      revisionId: chapters.headRevisionId,
    }).from(chapters)
      .leftJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
      .where(and(eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId)))
      .orderBy(asc(chapters.editorialPosition));
    const [release] = await db.select({ id: workReleases.id })
      .from(workReleases).where(eq(workReleases.workId, workId))
      .orderBy(sql`${workReleases.version} desc`).limit(1);
    return c.json({ work, releaseId: release?.id ?? null, chapters: rows });
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
      .where(sql`${chapters.id} = ${chapterId} and ${chapters.workId} = ${workId} and ${chapters.mergedIntoChapterId} is null`)
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

  // --- taxonomy admin (§03A v1.3 scope: create/rename/describe/sort/activate;
  // alias tables and merging are deferred backlog) ------------------------------
  const taxonomyRoutes = (
    kind: 'categories' | 'tags',
    table: typeof categories | typeof tags,
  ) => {
    const base = `/api/admin/taxonomy/${kind}`;
    const t = table as typeof categories;
    app.get(base, async (c) => {
      const includeInactive = c.req.query('includeInactive') === '1';
      const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));
      const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
      const rows = await db.select({
        id: t.id,
        displayName: t.displayName,
        description: t.description,
        sortOrder: t.sortOrder,
        isActive: t.isActive,
      }).from(t)
        .where(includeInactive ? sql`true` : eq(t.isActive, true))
        .orderBy(asc(t.sortOrder), asc(t.displayName))
        .limit(limit).offset(offset);
      const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(t);
      return c.json({ total: count.n, limit, offset, items: rows });
    });

    app.post(base, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
      if (!displayName || displayName.length > 50) return c.json({ error: 'invalid_taxonomy', detail: '名稱必填且不超過 50 字' }, 400);
      const description = typeof body?.description === 'string' ? body.description.slice(0, 500) : '';
      const sortOrder = Number.isInteger(body?.sortOrder) ? body.sortOrder : 0;
      try {
        const [row] = await db.insert(table).values({ displayName, description, sortOrder }).returning({
          id: t.id, displayName: t.displayName, description: t.description, sortOrder: t.sortOrder, isActive: t.isActive,
        });
        return c.json(row, 201);
      } catch (e) {
        // drizzle wraps pg errors — check the cause chain for unique violation
        const err = e as { code?: string; cause?: { code?: string } };
        if (err.code === '23505' || err.cause?.code === '23505') {
          return c.json({ error: 'invalid_taxonomy', detail: '名稱重複' }, 409);
        }
        throw e;
      }
    });

    app.patch(`${base}/:id`, async (c) => {
      const id = c.req.param('id');
      if (!UUID_RE.test(id)) return c.json({ error: 'invalid_taxonomy' }, 400);
      const body = await c.req.json().catch(() => ({}));
      const patch: Record<string, unknown> = {};
      if (typeof body?.displayName === 'string' && body.displayName.trim()) patch.displayName = body.displayName.trim().slice(0, 50);
      if (typeof body?.description === 'string') patch.description = body.description.slice(0, 500);
      if (Number.isInteger(body?.sortOrder)) patch.sortOrder = body.sortOrder;
      if (typeof body?.isActive === 'boolean') patch.isActive = body.isActive;
      if (Object.keys(patch).length === 0) return c.json({ error: 'invalid_taxonomy', detail: '沒有可更新的欄位' }, 400);
      patch.version = sql`${(table as typeof categories).version} + 1`;
      const [row] = await db.update(table).set(patch).where(eq((table as typeof categories).id, id)).returning({
        id: t.id, displayName: t.displayName, description: t.description, sortOrder: t.sortOrder, isActive: t.isActive,
      });
      if (!row) return c.json({ error: 'invalid_taxonomy', detail: '找不到項目' }, 404);
      return c.json(row);
    });
  };

  taxonomyRoutes('categories', categories);
  taxonomyRoutes('tags', tags);

  // --- per-work assignment -----------------------------------------------------
  app.get('/api/admin/works/:workId/taxonomy', async (c) => {
    const workId = routeId(c);
    if (!UUID_RE.test(workId)) return c.json({ error: 'work_not_found' }, 404);
    const cats = await db.select({
      id: categories.id, displayName: categories.displayName, isActive: categories.isActive,
    }).from(workCategories).innerJoin(categories, eq(categories.id, workCategories.categoryId))
      .where(eq(workCategories.workId, workId));
    const tgs = await db.select({
      id: tags.id, displayName: tags.displayName, isActive: tags.isActive,
    }).from(workTags).innerJoin(tags, eq(tags.id, workTags.tagId))
      .where(eq(workTags.workId, workId));
    return c.json({
      categoryIds: cats.map((x) => x.id),
      tagIds: tgs.map((x) => x.id),
      categories: cats,
      tags: tgs,
    });
  });

  // replace-set assignment. Import never touches these — this is the only
  // write path. Policy: inactive taxonomy cannot be NEWLY assigned, but rows
  // already assigned to the work stay even if later deactivated (public works
  // never silently lose metadata; they surface in the Admin review list).
  app.put('/api/admin/works/:workId/taxonomy', async (c) => {
    const workId = routeId(c);
    if (!UUID_RE.test(workId)) return c.json({ error: 'work_not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const checked = validateTaxonomyIds(body?.categoryIds, body?.tagIds);
    if ('error' in checked) return c.json(checked, 400);
    const { categoryIds, tagIds } = checked;
    const [work] = await db.select({ id: works.id }).from(works).where(eq(works.id, workId)).limit(1);
    if (!work) return c.json({ error: 'work_not_found' }, 404);

    const problem = await db.transaction((tx) => assignWorkTaxonomy(tx, workId, categoryIds, tagIds));
    if (problem) return c.json(problem, 400);
    return c.json({ categoryIds, tagIds });
  });

  return app;
}
