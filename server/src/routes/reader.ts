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
import { and, isNull, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  chapters, chapterRevisions, chapterRevisionResources, releaseItems, resources,
  works, workReleases,
} from '../db/schema.ts';
import type { Storage } from '../storage.ts';
import { variantsForSearch } from '../search/normalize.ts';
import { parseRef } from '../lib/slug.ts';

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
//
// `ref` is whatever the URL carried: a `<slug>-<publicId>` segment, a bare
// public id, or a uuid. Both forms resolve through a unique index; the slug
// text is never consulted, so editing a title cannot orphan a published link.
export async function visibleWork(db: NodePgDatabase, ref: string, role: string):
  Promise<{ ok: true; work: ReaderWork } | { ok: false; error: 'work_not_found' | 'forbidden' }> {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, error: 'work_not_found' };
  const [work] = await db.select().from(works)
    .where('workId' in parsed ? eq(works.id, parsed.workId) : eq(works.publicId, parsed.publicId))
    .limit(1);
  if (!work || work.visibility === 'removed') return { ok: false, error: 'work_not_found' };
  if (work.visibility === 'draft' && role !== 'admin') return { ok: false, error: 'forbidden' };
  return { ok: true, work };
}

const routeId = (c: Context): string => c.req.param('id') as string;

// which content source applies: ONLY draft works previewed by Admin may read
// the editorial head; everything else reads the active release, and a public
// work without any release exposes nothing (never the head).
function contentSource(work: ReaderWork, role: string): 'release' | 'head' | 'none' {
  if (work.visibility === 'draft' && role === 'admin') return 'head';
  return work.activeReleaseId ? 'release' : 'none';
}

export function readerRoutes(deps: ReaderRoutesDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db, storage } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  app.get('/api/reader/works/:id', async (c) => {
    const v = await visibleWork(db, routeId(c), c.get('role') ?? '');
    if (!v.ok) return c.json({ error: v.error }, v.error === 'forbidden' ? 403 : 404);
    const work = v.work;
    const source = contentSource(work, c.get('role') ?? '');

    if (source === 'none') {
      // public work, no publication yet — nothing is readable (§8)
      return c.json({
        id: work.id, publicId: work.publicId, title: work.title, author: work.author,
        workType: work.workType, serialStatus: work.serialStatus,
        description: work.description, visibility: work.visibility,
        chapterCount: 0, firstChapterId: null, latestChapterId: null,
        releaseId: null, releaseVersion: null, publishedAt: null,
      });
    }

    if (source === 'head') {
      // draft preview: editorial counts (M5 semantics, Admin only)
      const [counts] = await db.select({ n: sql<number>`count(*)::int` })
        .from(chapters).where(and(eq(chapters.workId, work.id), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt)));
      let firstChapterId: string | null = null;
      let latestChapterId: string | null = null;
      if (counts.n > 0) {
        const ends = await db.select({
          first: sql<string>`(array_agg(${chapters.id} order by ${chapters.editorialPosition} asc))[1]`,
          latest: sql<string>`(array_agg(${chapters.id} order by ${chapters.editorialPosition} desc))[1]`,
        }).from(chapters).where(and(eq(chapters.workId, work.id), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt)));
        firstChapterId = ends[0].first;
        latestChapterId = ends[0].latest;
      }
      return c.json({
        id: work.id,
        publicId: work.publicId,
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
      publicId: work.publicId,
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
    const v = await visibleWork(db, routeId(c), c.get('role') ?? '');
    if (!v.ok) return c.json({ error: v.error }, v.error === 'forbidden' ? 403 : 404);
    const work = v.work;
    const id = work.id;
    const limit = Math.min(500, Math.max(1, Math.floor(Number(c.req.query('limit')) || 200)));
    const offset = Math.max(0, Math.floor(Number(c.req.query('offset')) || 0));
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) return c.json({ error: 'invalid_filter' }, 400);
    const around = c.req.query('aroundChapterId');
    const latest = c.req.query('latest') === 'true';
    const order = c.req.query('order') ?? 'asc';
    const query = (c.req.query('q') ?? '').trim();
    if ((around && !UUID_RE.test(around)) || !['asc', 'desc'].includes(order) || query.length > 200) {
      return c.json({ error: 'invalid_filter' }, 400);
    }
    const source = contentSource(work, c.get('role') ?? '');
    // Only metadata enters this CTE. No canonical bodies or storage I/O.
    // The release branch joins chapters for public_id only: every other column
    // must come from the snapshot (ri), which is what the public is reading —
    // a label edited after publication does not change the published TOC.
    const base = source === 'head' ? sql`
      select c.id, c.public_id as "publicId", c.volume_id as "volumeId", c.label_raw as "labelRaw",
        coalesce(r.title, '') as title, c.editorial_position as "editorialPosition",
        c.head_revision_id as "revisionId"
      from app.chapters c left join app.chapter_revisions r on r.id = c.head_revision_id
      where c.work_id = ${id} and c.merged_into_chapter_id is null and c.deleted_at is null`
      : sql`select ri.chapter_id as id, c.public_id as "publicId", ri.volume_id as "volumeId",
          ri.label_raw as "labelRaw", ri.title, ri.editorial_position as "editorialPosition",
          ri.revision_id as "revisionId"
        from app.release_items ri join app.chapters c on c.id = ri.chapter_id
        where ri.release_id = ${source === 'release' ? work.activeReleaseId : null}`;
    const variants = query ? await variantsForSearch(query.toLocaleLowerCase()) : [];
    const matches = variants.length ? sql.join(variants.map((term) => sql`
      (strpos(lower("labelRaw"), ${term}) > 0 or strpos(lower(title), ${term}) > 0)`), sql` or `) : sql`true`;
    const direction = order === 'desc' ? sql`desc` : sql`asc`;
    const result = await db.execute(sql`
      with base as (${base}),
      ranked as (select *, (row_number() over (order by "editorialPosition" ${direction}) - 1)::int as ordinal
        from base where ${matches}),
      stats as (select count(*)::int as total,
        ${source === 'head' ? sql`'head:' || md5(coalesce((select string_agg(row(base.*)::text, ',' order by "editorialPosition") from base), ''))`
          : sql`${work.activeReleaseId ?? 'none'}::text`} as version,
        (select ordinal from ranked where id = ${around ?? null}::uuid) as anchor,
        (select ordinal from ranked order by "editorialPosition" desc limit 1) as latest from ranked),
      bounds as (select *, case
        when ${latest} and latest is not null then greatest(0, least(total - ${limit}, latest - ${Math.floor(limit / 2)}))
        when ${Boolean(around)} and anchor is not null then greatest(0, least(total - ${limit}, anchor - ${Math.floor(limit / 2)}))
        else least(${offset}, greatest(0, total - 1)) end as start from stats)
      select total, version, start as offset,
        (${Boolean(around)} and anchor is null) as "anchorMissing",
        coalesce((select json_agg(json_build_object('id', id, 'publicId', "publicId",
          'volumeId', "volumeId", 'labelRaw', "labelRaw",
          'title', title, 'editorialPosition', "editorialPosition", 'revisionId', "revisionId") order by ordinal)
          from ranked where ordinal >= bounds.start and ordinal < bounds.start + ${limit}), '[]'::json) as chapters
      from bounds`);
    const page = result.rows[0] as {
      total: number; version: string; offset: number; anchorMissing: boolean; chapters: unknown[];
    };
    if (c.req.query('version') && c.req.query('version') !== page.version) {
      return c.json({ error: 'toc_version_changed', version: page.version }, 409);
    }
    return c.json({ ...page, limit,
      previousOffset: page.offset > 0 ? Math.max(0, page.offset - limit) : null,
      nextOffset: page.offset + limit < page.total ? page.offset + limit : null,
    });
  });

  // chapter content — release snapshot for the public; head only for draft
  // preview (Admin). Head content of a PUBLISHED work belongs to the Admin
  // preview routes, deliberately not here.
  app.get('/api/reader/chapters/:id', async (c) => {
    // A chapter public id is unique per work, not globally (see schema.ts), so
    // resolving one needs the work: `?work=<ref>` carries it, and the reader
    // always has it — the chapter path is nested under the work path. A uuid
    // needs no such help and keeps working on its own, which is what every
    // in-app navigation and every bookmark deep link uses.
    const ref = parseRef(routeId(c));
    if (!ref) return c.json({ error: 'chapter_not_found' }, 404);
    let chapterId: string;
    if ('workId' in ref) {
      chapterId = ref.workId;      // a uuid segment: the chapter's own id
    } else {
      const workRef = c.req.query('work');
      if (!workRef) return c.json({ error: 'chapter_not_found' }, 404);
      const owner = await visibleWork(db, workRef, c.get('role') ?? '');
      if (!owner.ok) return c.json({ error: owner.error }, owner.error === 'forbidden' ? 403 : 404);
      const [found] = await db.select({ id: chapters.id }).from(chapters)
        .where(and(eq(chapters.workId, owner.work.id), eq(chapters.publicId, ref.publicId))).limit(1);
      if (!found) return c.json({ error: 'chapter_not_found' }, 404);
      chapterId = found.id;
    }
    const id = chapterId;
    const rows = await db.select({ chapterId: chapters.id, publicId: chapters.publicId, workId: chapters.workId })
      .from(chapters).where(eq(chapters.id, id)).limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: 'chapter_not_found' }, 404);
    const v = await visibleWork(db, row.workId, c.get('role') ?? '');
    if (!v.ok) return c.json({ error: v.error }, v.error === 'forbidden' ? 403 : 404);
    const work = v.work;
    const source = contentSource(work, c.get('role') ?? '');
    if (source === 'none') return c.json({ error: 'no_active_release' }, 404);

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
      }).from(chapters).where(and(eq(chapters.id, id), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt))).limit(1);
      if (!head) return c.json({ error: 'chapter_not_found' }, 404);
      const neighbors = await db.select({
        prev: sql<string | null>`(select c2.id from app.chapters c2
          where c2.work_id = ${work.id} and c2.merged_into_chapter_id is null and c2.deleted_at is null and c2.editorial_position < ${head.editorialPosition}
          order by c2.editorial_position desc limit 1)`,
        next: sql<string | null>`(select c2.id from app.chapters c2
          where c2.work_id = ${work.id} and c2.merged_into_chapter_id is null and c2.deleted_at is null and c2.editorial_position > ${head.editorialPosition}
          order by c2.editorial_position asc limit 1)`,
      }).from(chapters).where(and(eq(chapters.id, id), isNull(chapters.mergedIntoChapterId), isNull(chapters.deletedAt))).limit(1);
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

    // resource manifest for this revision (ADR-08): the body carries
    // [[img:<hash>]] markers and the reader resolves each to a URL from here.
    // Scoped to the revision, so a stale body can never pull in a newer
    // revision's images.
    const resourceRows = await db.select({
      contentHash: chapterRevisionResources.contentHash,
      alt: chapterRevisionResources.alt,
      mediaType: resources.mediaType,
      sizeBytes: resources.sizeBytes,
    }).from(chapterRevisionResources)
      .innerJoin(resources, eq(resources.id, chapterRevisionResources.resourceId))
      .where(eq(chapterRevisionResources.revisionId, revisionId));

    return c.json({
      chapterId: row.chapterId,
      // the URL-facing key, so the reader can put the canonical path in the
      // address bar and in <link rel="canonical"> as soon as the text lands
      publicId: row.publicId,
      workId: row.workId,
      revisionId,
      labelRaw,
      title: revision.title,
      body,
      previousChapterId,
      nextChapterId,
      paragraphCount: splitParagraphs(body).length,
      updatedAt: revision.createdAt.toISOString(),
      resources: resourceRows.map((r) => ({
        contentHash: r.contentHash,
        url: `/api/reader/resources/${r.contentHash}`,
        mediaType: r.mediaType,
        sizeBytes: r.sizeBytes,
        alt: r.alt,
      })),
    });
  });

  // Resource bytes. Content-addressed, so the URL is immutable and cacheable;
  // authorization is by reachability, not by knowing the hash:
  //
  //   public  — the resource is referenced by a revision inside the ACTIVE
  //             release of a public/unlisted work (i.e. content anyone may
  //             already read as prose)
  //   admin   — anything else, including draft-only resources
  //
  // Checking reachability rather than trusting the hash means an unpublished
  // image cannot be fetched by someone who guessed or scraped its hash from a
  // draft preview.
  app.get('/api/reader/resources/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!/^[0-9a-f]{64}$/.test(hash)) return c.json({ error: 'resource_not_found' }, 404);

    const [res] = await db.select({
      storageKey: resources.storageKey,
      mediaType: resources.mediaType,
      publiclyReachable: sql<boolean>`exists (
        select 1
        from app.chapter_revision_resources rr
        join app.release_items ri on ri.revision_id = rr.revision_id
        join app.works w on w.active_release_id = ri.release_id
        where rr.content_hash = ${hash}
          and w.visibility in ('public','unlisted'))`,
    }).from(resources).where(eq(resources.contentHash, hash)).limit(1);
    if (!res) return c.json({ error: 'resource_not_found' }, 404);
    if (!res.publiclyReachable && c.get('role') !== 'admin') {
      return c.json({ error: 'forbidden' }, 403);
    }

    let bytes: Buffer;
    try {
      bytes = await storage.get(res.storageKey);
    } catch {
      return c.json({ error: 'content_unavailable' }, 409);
    }
    // Immutable by construction (the URL *is* the content hash), so it can be
    // cached hard. This overrides the global no-store: a resource carries no
    // member state, and re-fetching every image on every chapter turn would be
    // the single worst thing for mobile reading.
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Type', res.mediaType);
    c.header('Content-Length', String(bytes.length));
    // never let a browser treat an image response as a document
    c.header('Content-Disposition', 'inline');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(bytes));
  });

  return app;
}
