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
import { decodeCursor, encodeCursor, filterFingerprint } from '../catalog/cursor.ts';

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

// Single filter predicate builder shared by the list and the count endpoints
// (§03A-F: "前端、API、count 查詢共用一個 filter predicate builder"). Both
// endpoints must reject the same invalid input and must never silently widen
// the result set, so validation lives here too — duplicating it would let the
// two paths drift and report a count that does not match the list.
export interface CatalogFilterError {
  error: 'invalid_filter';
  field: string;
}
export interface CatalogFilter {
  conds: SQL[];
  limit: number;
  sort: SortKey;
  /** identity of this normalized condition set; a cursor is bound to it */
  fingerprint: string;
}

export async function buildCatalogFilter(
  query: (key: string) => string | undefined,
): Promise<CatalogFilter | CatalogFilterError> {
  const limit = Math.min(50, Math.max(1, Number(query('limit') ?? 20) || 20));
  const q = (query('q') ?? '').trim().slice(0, 100);
  const typeRaw = query('type') || null;
  if (typeRaw && !['short_story', 'serial'].includes(typeRaw)) {
    return { error: 'invalid_filter', field: 'type' };
  }
  const type = typeRaw as 'short_story' | 'serial' | null;
  const serialStatus = (query('serialStatus') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (serialStatus.some((s) => !['ongoing', 'completed', 'paused'].includes(s))) {
    return { error: 'invalid_filter', field: 'serialStatus' };
  }
  const categoryIds = parseUuidList(query('categoryIds'));
  const tagIds = parseUuidList(query('tagIds'));
  if (categoryIds === null || tagIds === null) {
    return { error: 'invalid_filter', field: 'ids' };
  }
  const tagMode = query('tagMode') === 'any' ? 'any' : 'all';
  const sortParam = query('sort') ?? 'updated';
  if (!(sortParam in SORTS)) return { error: 'invalid_filter', field: 'sort' };

  // Normalized identity of this condition set. Ids are sorted and de-duplicated
  // so that semantically identical requests ("a,b" vs "b,a") share one cursor
  // space; tagMode only participates when tags are actually selected, matching
  // the predicate below (§03A-B: an unselected dimension does not constrain).
  const fingerprint = filterFingerprint([
    `type=${type ?? ''}`,
    `cat=${[...new Set(categoryIds)].sort().join('.')}`,
    `tag=${[...new Set(tagIds)].sort().join('.')}`,
    `mode=${tagIds.length > 0 ? tagMode : ''}`,
    `status=${[...new Set(serialStatus)].sort().join('.')}`,
    `q=${q}`,
    `sort=${sortParam}`,
  ]);

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
  return { conds, limit, sort: sortParam as SortKey, fingerprint };
}

// Exact text form of each sort key, used both to emit a cursor and to compare
// against one. published_at is rendered at microsecond precision on purpose: a
// JS Date only carries milliseconds, and truncating it would make two releases
// published in the same millisecond order inconsistently between the ORDER BY
// and the keyset predicate — the one way a keyset cursor can still skip a row.
const SORT_VALUE_SQL = {
  updated: sql<string>`to_char(${workReleases.publishedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  title: sql<string>`${works.title}`,
} as const;

// Keyset predicate for "strictly after this row in the sort order". The
// directions are mixed (published_at DESC, id ASC), so a row-value comparison
// does not apply and the two cases are spelled out.
function afterCursor(sort: SortKey, key: string, id: string): SQL {
  if (sort === 'updated') {
    return sql`(${workReleases.publishedAt} < ${key}::timestamptz
      or (${workReleases.publishedAt} = ${key}::timestamptz and ${works.id} > ${id}::uuid))`;
  }
  return sql`(${works.title} > ${key}
    or (${works.title} = ${key} and ${works.id} > ${id}::uuid))`;
}

export function worksRoutes(deps: CatalogDeps): Hono<Record<string, never>> {
  const { db } = deps;
  const app = new Hono<Record<string, never>>();

  app.get('/api/works', async (c) => {
    const filter = await buildCatalogFilter((k) => c.req.query(k));
    if ('error' in filter) return c.json(filter, 400);
    const { conds, limit } = filter;

    const rawCursor = c.req.query('cursor');
    if (rawCursor) {
      const decoded = decodeCursor(rawCursor, filter.fingerprint);
      if (!decoded.ok) return c.json({ error: decoded.error }, 400);
      conds.push(afterCursor(filter.sort, decoded.cursor.k, decoded.cursor.id));
    }

    // fetch one extra row to learn whether a further page exists without
    // running a second query
    const rows = await db.select({
      id: works.id,
      sortValue: SORT_VALUE_SQL[filter.sort],
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
      .orderBy(SORTS[filter.sort], asc(works.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last
      ? encodeCursor({ v: 1, f: filter.fingerprint, k: last.sortValue, id: last.id })
      : null;

    return c.json({
      total: null, // count endpoint exists separately; lists stay cheap
      limit,
      nextCursor,
      works: page.map(({ sortValue: _sortValue, ...w }) => ({
        ...w,
        latestPublishedAt: w.latestPublishedAt.toISOString(),
      })),
    });
  });

  // same filters as the list, no pagination (§03A-F). The count is distinct by
  // work because works→work_releases joins on the single active release, so one
  // work can never contribute two rows.
  app.get('/api/works/count', async (c) => {
    const filter = await buildCatalogFilter((k) => c.req.query(k));
    if ('error' in filter) return c.json(filter, 400);
    const [row] = await db.select({ n: sql<number>`count(distinct ${works.id})::int` })
      .from(works)
      .innerJoin(workReleases, eq(workReleases.id, works.activeReleaseId))
      .where(and(...filter.conds));
    return c.json({ count: row.n });
  });

  // public taxonomy lists for the catalog filter sheet (active only)
  app.get('/api/taxonomy/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (kind !== 'categories' && kind !== 'tags') return c.json({ error: 'invalid_filter' }, 400);
    const table = kind === 'categories' ? categories : tags;
    const rows = await db.select({
      id: table.id, displayName: table.displayName,
    }).from(table)
      .where(eq(table.isActive, true))
      .orderBy(asc(table.sortOrder), asc(table.displayName))
      .limit(200);
    return c.json({ items: rows });
  });

  app.get('/api/works/:id/related', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'work_not_found' }, 404);
    const [source] = await db.select({ id: works.id }).from(works)
      .where(sql`${works.id} = ${id} and ${works.visibility} in ('public','unlisted') and ${works.activeReleaseId} is not null`).limit(1);
    if (!source) return c.json({ error: 'work_not_found' }, 404);
    const result = await db.execute(sql`
      with category_matches as (
        select candidate.work_id, count(*)::int as shared_categories
        from app.work_categories seed
        join app.categories ct on ct.id = seed.category_id and ct.is_active
        join app.work_categories candidate on candidate.category_id = seed.category_id
        where seed.work_id = ${id}::uuid and candidate.work_id <> ${id}::uuid
        group by candidate.work_id
      ), tag_matches as (
        select candidate.work_id, count(*)::int as shared_tags
        from app.work_tags seed
        join app.tags tg on tg.id = seed.tag_id and tg.is_active
        join app.work_tags candidate on candidate.tag_id = seed.tag_id
        where seed.work_id = ${id}::uuid and candidate.work_id <> ${id}::uuid
        group by candidate.work_id
      )
      select w.id, w.title, w.author, w.work_type, w.serial_status, r.chapter_count,
             coalesce(cm.shared_categories, 0) as shared_categories, coalesce(tm.shared_tags, 0) as shared_tags
      from app.works w
      join app.work_releases r on r.id = w.active_release_id and r.work_id = w.id
      left join category_matches cm on cm.work_id = w.id
      left join tag_matches tm on tm.work_id = w.id
      where w.visibility = 'public' and (cm.work_id is not null or tm.work_id is not null)
      order by coalesce(tm.shared_tags, 0) desc, coalesce(cm.shared_categories, 0) desc, w.title asc, w.id asc
      limit 6`);
    return c.json({ works: result.rows.map((row) => ({ id: row.id, title: row.title, author: row.author,
      workType: row.work_type, serialStatus: row.serial_status, chapterCount: row.chapter_count,
      sharedCategories: Number(row.shared_categories), sharedTags: Number(row.shared_tags) })) });
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
