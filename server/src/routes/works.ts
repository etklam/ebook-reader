// Public catalog (M6): listed works only (visibility=public + active release).
// Metadata-only DTOs — chapter bodies are never touched, no N+1 (taxonomy
// aggregates are grouped subqueries). Filtering follows the confirmed contract
// (dev-plan §03A): dimensions AND-combined; categories OR within the
// dimension; tags all/any (default all); serial statuses OR. Zero results is
// a truthful empty list — filters are never silently weakened.
import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { categories, releaseItems, tags, workCategories, workReleases, works, workTags } from '../db/schema.ts';

export interface CatalogDeps {
  db: NodePgDatabase;
}

const SORTS = {
  updated: desc(workReleases.publishedAt), // most recent publication first
  title: asc(works.title),
} as const;
type SortKey = keyof typeof SORTS;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuidList(raw: string | undefined): string[] | null {
  if (!raw) return [];
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.every((p) => UUID_RE.test(p)) ? parts : null;
}

// Traditional/Simplified-equivalent metadata search (§16): query-time only —
// the keyword is matched against both script variants; rows are never
// converted. Variants come from the shared opencc converter (lazy-loaded).
async function searchVariants(q: string): Promise<string[]> {
  const { variantsForSearch } = await import('../search/normalize.ts');
  return variantsForSearch(q);
}

export function worksRoutes(deps: CatalogDeps): Hono<Record<string, never>> {
  const { db } = deps;
  const app = new Hono<Record<string, never>>();

  app.get('/api/works', async (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const typeRaw = c.req.query('type') || null;
    if (typeRaw && !['short_story', 'serial'].includes(typeRaw)) {
      return c.json({ error: 'invalid_filter', field: 'type' }, 400);
    }
    const type = typeRaw as 'short_story' | 'serial' | null;
    const serialStatus = (c.req.query('serialStatus') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (serialStatus.some((s) => !['ongoing', 'completed', 'paused'].includes(s))) {
      return c.json({ error: 'invalid_filter', field: 'serialStatus' }, 400);
    }
    const categoryIds = parseUuidList(c.req.query('categoryIds'));
    const tagIds = parseUuidList(c.req.query('tagIds'));
    if (categoryIds === null || tagIds === null) {
      return c.json({ error: 'invalid_filter', field: 'ids' }, 400);
    }
    const tagMode = c.req.query('tagMode') === 'any' ? 'any' : 'all';
    const sortParam = c.req.query('sort') ?? 'updated';
    if (!(sortParam in SORTS)) return c.json({ error: 'invalid_filter', field: 'sort' }, 400);

    // base predicate: discoverable = public + published
    const conds: SQL[] = [
      eq(works.visibility, 'public'),
      isNotNull(works.activeReleaseId),
    ];
    if (type) conds.push(eq(works.workType, type));
    if (serialStatus.length > 0) {
      conds.push(inArray(works.serialStatus, serialStatus as ('ongoing' | 'completed' | 'paused')[]));
    }
    if (categoryIds.length > 0) {
      conds.push(sql`exists (
        select 1 from ${workCategories} wc
        where wc.work_id = ${works.id} and wc.category_id = any(${sql.param(categoryIds)}::uuid[]))`);
    }
    if (tagIds.length > 0) {
      conds.push(tagMode === 'all'
        // every selected tag present: no selected tag is missing from the work
        ? sql`not exists (
            select x from unnest(${sql.param(tagIds)}::uuid[]) as x(id)
            where not exists (
              select 1 from ${workTags} wt
              where wt.work_id = ${works.id} and wt.tag_id = x.id))`
        : sql`exists (
            select 1 from ${workTags} wt
            where wt.work_id = ${works.id} and wt.tag_id = any(${sql.param(tagIds)}::uuid[]))`);
    }
    if (q) {
      const likeVariants = (await searchVariants(q)).map((v) => `%${v}%`);
      const textMatch = or(...likeVariants.map((v) => [
        sql`${works.title} ilike ${v}`,
        sql`${works.author} ilike ${v}`,
      ]).flat());
      conds.push(sql`(
        ${textMatch}
        or exists (select 1 from ${workCategories} wc
                   join ${categories} ct on ct.id = wc.category_id
                   where wc.work_id = ${works.id} and ${or(...likeVariants.map((v) => sql`ct.display_name ilike ${v}`))})
        or exists (select 1 from ${workTags} wt
                   join ${tags} tg on tg.id = wt.tag_id
                   where wt.work_id = ${works.id} and ${or(...likeVariants.map((v) => sql`tg.display_name ilike ${v}`))})
      )`);
    }

    const rows = await db.select({
      id: works.id,
      title: works.title,
      author: works.author,
      description: works.description,
      workType: works.workType,
      serialStatus: works.serialStatus,
      chapterCount: workReleases.chapterCount,
      latestPublishedAt: workReleases.publishedAt,
      categories: sql<string[]>`coalesce((
        select array_agg(ct.display_name order by ct.display_name)
        from ${workCategories} wc join ${categories} ct on ct.id = wc.category_id
        where wc.work_id = ${works.id} and ct.is_active), '{}')`,
      tags: sql<string[]>`coalesce((
        select array_agg(tg.display_name order by tg.display_name)
        from ${workTags} wt join ${tags} tg on tg.id = wt.tag_id
        where wt.work_id = ${works.id} and tg.is_active), '{}')`,
    }).from(works)
      .innerJoin(workReleases, eq(workReleases.id, works.activeReleaseId))
      .where(and(...conds))
      .orderBy(SORTS[sortParam as SortKey], asc(works.id))
      .limit(limit).offset(offset);

    return c.json({
      total: null, // count endpoint exists separately; lists stay cheap
      limit,
      offset,
      works: rows.map((w) => ({ ...w, latestPublishedAt: w.latestPublishedAt.toISOString() })),
    });
  });

  app.get('/api/works/count', async (c) => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` })
      .from(works)
      .where(and(eq(works.visibility, 'public'), isNotNull(works.activeReleaseId)));
    return c.json({ count: row.n });
  });

  // public work detail: release-scoped metadata + lightweight TOC head
  app.get('/api/works/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'work_not_found' }, 404);
    const rows = await db.select({
      id: works.id,
      title: works.title,
      author: works.author,
      description: works.description,
      workType: works.workType,
      serialStatus: works.serialStatus,
      visibility: works.visibility,
      releaseId: workReleases.id,
      releaseVersion: workReleases.version,
      publishedAt: workReleases.publishedAt,
      chapterCount: workReleases.chapterCount,
    }).from(works)
      .innerJoin(workReleases, eq(workReleases.id, works.activeReleaseId))
      .where(sql`${works.id} = ${id} and ${works.visibility} in ('public','unlisted')`)
      .limit(1);
    if (!rows[0]) return c.json({ error: 'work_not_found' }, 404);
    const work = rows[0];
    const first = await db.select({
      id: releaseItems.chapterId,
      labelRaw: releaseItems.labelRaw,
      title: releaseItems.title,
    }).from(releaseItems)
      .where(eq(releaseItems.releaseId, work.releaseId))
      .orderBy(asc(releaseItems.editorialPosition))
      .limit(1);
    return c.json({
      ...work,
      publishedAt: work.publishedAt.toISOString(),
      firstChapterId: first[0]?.id ?? null,
      categories: (await db.select({ name: categories.displayName })
        .from(workCategories)
        .innerJoin(categories, eq(categories.id, workCategories.categoryId))
        .where(sql`${workCategories.workId} = ${id} and ${categories.isActive}`)).map((r) => r.name),
      tags: (await db.select({ name: tags.displayName })
        .from(workTags)
        .innerJoin(tags, eq(tags.id, workTags.tagId))
        .where(sql`${workTags.workId} = ${id} and ${tags.isActive}`)).map((r) => r.name),
    });
  });

  return app;
}
