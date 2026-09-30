// Admin work routes (M6): explicit publication, publish preview, editorial
// HEAD preview (never leaked via /api/reader), and taxonomy management
// (categories/tags CRUD + per-work assignment). Publish is a deliberate
// operation — import/apply never publishes.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  categories, chapters, chapterRevisions, tags, workCategories, works, workReleases, workTags,
} from '../db/schema.ts';
import type { Storage } from '../storage.ts';
import { publishPreview, publishWork } from '../publish/publish.ts';

export interface AdminWorksDeps {
  db: NodePgDatabase;
  storage: Storage;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routeId = (c: Context): string => c.req.param('workId') as string;

// configurable assignment limits (dev-plan §03A: ~5 categories / ~20 tags)
export const MAX_CATEGORIES_PER_WORK = 5;
export const MAX_TAGS_PER_WORK = 20;

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
    const categoryIds = Array.isArray(body?.categoryIds) ? body.categoryIds : [];
    const tagIds = Array.isArray(body?.tagIds) ? body.tagIds : [];
    const validIds = (ids: unknown[]): ids is string[] => ids.every((i) => typeof i === 'string' && UUID_RE.test(i));
    if (!validIds(categoryIds) || !validIds(tagIds)) return c.json({ error: 'invalid_taxonomy', detail: 'id 格式錯誤' }, 400);
    if (new Set(categoryIds).size !== categoryIds.length || new Set(tagIds).size !== tagIds.length) {
      return c.json({ error: 'invalid_taxonomy', detail: 'id 重複' }, 400);
    }
    if (categoryIds.length > MAX_CATEGORIES_PER_WORK) {
      return c.json({ error: 'invalid_taxonomy', detail: `分類上限 ${MAX_CATEGORIES_PER_WORK}` }, 400);
    }
    if (tagIds.length > MAX_TAGS_PER_WORK) {
      return c.json({ error: 'invalid_taxonomy', detail: `標籤上限 ${MAX_TAGS_PER_WORK}` }, 400);
    }
    const [work] = await db.select({ id: works.id }).from(works).where(eq(works.id, workId)).limit(1);
    if (!work) return c.json({ error: 'work_not_found' }, 404);

    const currently = await db.transaction(async (tx) => {
      const currentCats = (await tx.select({ id: workCategories.categoryId })
        .from(workCategories).where(eq(workCategories.workId, workId))).map((r) => r.id);
      const currentTags = (await tx.select({ id: workTags.tagId })
        .from(workTags).where(eq(workTags.workId, workId))).map((r) => r.id);
      // newly assigned ids must exist and be active
      for (const [table, ids, current] of [
        [categories, categoryIds, currentCats],
        [tags, tagIds, currentTags],
      ] as const) {
        const newIds = ids.filter((id) => !current.includes(id));
        if (newIds.length === 0) continue;
        const rows = await tx.select({ id: table.id, isActive: table.isActive })
          .from(table).where(inArray(table.id, newIds));
        if (rows.length !== new Set(newIds).size) {
          return { error: 'invalid_taxonomy' as const, detail: '包含不存在的項目' };
        }
        if (rows.some((r) => !r.isActive)) {
          return { error: 'invalid_taxonomy' as const, detail: '停用中的項目不能新指派' };
        }
      }
      await tx.delete(workCategories).where(eq(workCategories.workId, workId));
      await tx.delete(workTags).where(eq(workTags.workId, workId));
      if (categoryIds.length > 0) {
        await tx.insert(workCategories).values(categoryIds.map((categoryId) => ({ workId, categoryId })));
      }
      if (tagIds.length > 0) {
        await tx.insert(workTags).values(tagIds.map((tagId) => ({ workId, tagId })));
      }
      return { error: null, detail: null };
    });
    if (currently.error) return c.json(currently, 400);
    return c.json({ categoryIds, tagIds });
  });

  return app;
}
