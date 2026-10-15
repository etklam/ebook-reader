// Reader full-text search and explicit-version TXT/EPUB downloads.
import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { bookFormatters, ExportContentUnavailable, loadExportBook, type ExportChapter as SelectedExportChapter, type ExportResource } from '../export/formatters.ts';
import {
  chapterRevisionResources, chapterRevisions, chapters, releaseItems, resources,
  workReleases, works,
} from '../db/schema.ts';
import type { Storage } from '../storage.ts';
import { variantsForSearch } from '../search/normalize.ts';
import { clientIp, createRateLimiter, rateLimit } from '../http/rate-limit.ts';
import { findChapterMatch } from '../search/chapter-search.ts';
import { filterFingerprint } from '../catalog/cursor.ts';
import { decodeSearchCursor, encodeSearchCursor } from '../search/search-cursor.ts';

export interface SearchExportRoutesDeps {
  db: NodePgDatabase;
  storage: Storage;
  trustProxy?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESULTS = 50;

function filenamePart(value: string): string {
  return value.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'ebook';
}

type ExportChapter = {
  chapterId: string;
  revisionId: string;
  labelRaw: string;
  title: string;
  contentKey: string;
};

export function searchExportRoutes(deps: SearchExportRoutesDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db, storage } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  app.use('/api/reader/works/:id/search', rateLimit({
    limiter: createRateLimiter({ windowMs: 60_000, max: 10 }),
    keyOf: (c) => clientIp(c, deps.trustProxy ?? false), errorCode: 'too_many_requests',
  }));

  // Search follows reader visibility and the ACTIVE release. Draft head is
  // searchable only to Admin; historical releases are never exposed here.
  app.get('/api/reader/works/:id/search', async (c) => {
    const workId = c.req.param('id');
    if (!UUID_RE.test(workId)) return c.json({ error: 'work_not_found' }, 404);
    const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
    if (!work || work.visibility === 'removed') return c.json({ error: 'work_not_found' }, 404);
    const admin = c.get('role') === 'admin';
    if (work.visibility === 'draft' && !admin) return c.json({ error: 'forbidden' }, 403);

    const q = (c.req.query('q') ?? '').trim().replace(/\s+/g, ' ');
    if (!q) return c.json({ error: 'query_required' }, 400);
    if (q.length > 100) return c.json({ error: 'query_too_long' }, 400);
    const offsetText = c.req.query('offset') ?? '0';
    if (!/^\d{1,9}$/.test(offsetText)) return c.json({ error: 'invalid_offset' }, 400);
    if (Number(offsetText) !== 0) return c.json({ error: 'cursor_required' }, 400);
    const variants = await variantsForSearch(q);
    const rows: ExportChapter[] = work.visibility === 'draft' && admin
      ? await db.select({
        chapterId: chapters.id, revisionId: chapterRevisions.id,
        labelRaw: chapters.labelRaw, title: chapterRevisions.title,
        contentKey: chapterRevisions.contentKey,
      }).from(chapters)
        .innerJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
        .where(and(eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId))).orderBy(asc(chapters.editorialPosition))
      : work.activeReleaseId
        ? await db.select({
          chapterId: releaseItems.chapterId, revisionId: releaseItems.revisionId,
          labelRaw: releaseItems.labelRaw, title: releaseItems.title,
          contentKey: chapterRevisions.contentKey,
        }).from(releaseItems)
          .innerJoin(chapterRevisions, eq(chapterRevisions.id, releaseItems.revisionId))
          .where(eq(releaseItems.releaseId, work.activeReleaseId))
          .orderBy(asc(releaseItems.editorialPosition))
        : [];

    const filter = filterFingerprint([workId, q, work.visibility === 'draft' ? c.get('userId') ?? 'admin' : 'reader']);
    const revision = filterFingerprint([
      work.visibility === 'draft' ? `draft:${work.editVersion}` : work.activeReleaseId ?? 'none',
      ...rows.map((row) => `${row.chapterId}:${row.revisionId}`),
    ]);
    const cursorText = c.req.query('cursor');
    const cursor = cursorText ? decodeSearchCursor(cursorText, filter, revision, rows.length) : null;
    if (cursor && !cursor.ok) return c.json({ error: cursor.error }, cursor.status);
    const offset = cursor?.ok ? cursor.shown : 0;
    const first = cursor?.ok ? cursor.next : 0;
    let nextCursor: string | null = null;
    const results: Array<{
      chapterId: string; labelRaw: string; title: string; snippet: string;
      matchStart: number; matchLength: number; paragraphIndex: number; href: string;
    }> = [];
    // ponytail: metadata + bounded body batches, stop at the first lookahead
    // match. Sparse/no-hit searches still scan the suffix; index only if measured.
    scan: for (let start = first; start < rows.length; start += 8) {
      const batch = rows.slice(start, start + 8);
      const matches = await Promise.all(batch.map(async (row) => {
        let body: string;
        try { body = (await storage.get(row.contentKey)).toString('utf8'); }
        catch { return { unavailable: true } as const; }
        return { row, found: findChapterMatch(body, row.title, variants) };
      }));
      if (matches.some((match) => 'unavailable' in match)) {
        return c.json({ error: 'content_unavailable' }, 409);
      }
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        if ('unavailable' in match || !match.found) continue;
        const { row, found } = match;
        if (results.length === MAX_RESULTS) {
          // Include this lookahead chapter on the next page, never skip it.
          nextCursor = encodeSearchCursor(filter, revision, start + i, offset + results.length);
          break scan;
        }
        results.push({
          chapterId: row.chapterId, labelRaw: row.labelRaw, title: row.title,
          ...found,
          href: `/read/${workId}/${row.chapterId}#p=${found.paragraphIndex}&rev=${row.revisionId}`,
        });
      }
    }
    return c.json({ query: q, total: null, offset, nextCursor, hasMore: nextCursor !== null, results });
  });

  app.get('/api/admin/works/:workId/export-versions', async (c) => {
    const workId = c.req.param('workId');
    if (!UUID_RE.test(workId)) return c.json({ error: 'work_not_found' }, 404);
    const [work] = await db.select({ id: works.id, title: works.title, activeReleaseId: works.activeReleaseId })
      .from(works).where(eq(works.id, workId)).limit(1);
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    const releases = await db.select({ id: workReleases.id, version: workReleases.version,
      chapterCount: workReleases.chapterCount, publishedAt: workReleases.publishedAt })
      .from(workReleases).where(eq(workReleases.workId, workId)).orderBy(desc(workReleases.version));
    return c.json({
      work: { id: work.id, title: work.title },
      versions: [
        { id: 'head', label: '草稿目前版本', kind: 'head' },
        ...releases.map((release) => ({
          id: release.id, label: `v${release.version}${release.id === work.activeReleaseId ? '（目前發布）' : ''}`,
          kind: 'release', version: release.version, chapterCount: release.chapterCount,
          publishedAt: release.publishedAt.toISOString(), active: release.id === work.activeReleaseId,
        })),
      ],
    });
  });

  app.get('/api/admin/works/:workId/export', async (c) => {
    const workId = c.req.param('workId');
    if (!UUID_RE.test(workId)) return c.json({ error: 'work_not_found' }, 404);
    const format = c.req.query('format');
    const selection = c.req.query('version');
    if (format !== 'txt' && format !== 'epub') return c.json({ error: 'invalid_format' }, 400);
    if (!selection || (selection !== 'head' && !UUID_RE.test(selection))) {
      return c.json({ error: 'version_required' }, 400);
    }
    const [work] = await db.select({ id: works.id, title: works.title, author: works.author,
      description: works.description, visibility: works.visibility })
      .from(works).where(eq(works.id, workId)).limit(1);
    if (!work || work.visibility === 'removed') return c.json({ error: 'work_not_found' }, 404);

    let chaptersForExport: SelectedExportChapter[];
    let modifiedAt = new Date();
    let versionLabel: string;
    if (selection === 'head') {
      versionLabel = 'draft';
      chaptersForExport = await db.select({
        chapterId: chapters.id, revisionId: chapters.headRevisionId,
        labelRaw: chapters.labelRaw, title: chapterRevisions.title,
        contentKey: chapterRevisions.contentKey,
      }).from(chapters)
        .leftJoin(chapterRevisions, eq(chapterRevisions.id, chapters.headRevisionId))
        .where(and(eq(chapters.workId, workId), isNull(chapters.mergedIntoChapterId))).orderBy(asc(chapters.editorialPosition));
    } else {
      const [release] = await db.select({ id: workReleases.id, version: workReleases.version, publishedAt: workReleases.publishedAt })
        .from(workReleases).where(sql`${workReleases.id} = ${selection} and ${workReleases.workId} = ${workId}`).limit(1);
      if (!release) return c.json({ error: 'version_not_found' }, 404);
      versionLabel = `v${release.version}`;
      modifiedAt = release.publishedAt;
      chaptersForExport = await db.select({
        chapterId: releaseItems.chapterId, revisionId: releaseItems.revisionId,
        labelRaw: releaseItems.labelRaw, title: releaseItems.title,
        contentKey: chapterRevisions.contentKey,
      }).from(releaseItems)
        .leftJoin(chapterRevisions, eq(chapterRevisions.id, releaseItems.revisionId))
        .where(eq(releaseItems.releaseId, release.id)).orderBy(asc(releaseItems.editorialPosition));
    }
    if (chaptersForExport.length === 0) return c.json({ error: 'no_chapters' }, 409);

    const resourceRows: ExportResource[] = await db.select({
      revisionId: chapterRevisionResources.revisionId,
      hash: chapterRevisionResources.contentHash,
      alt: chapterRevisionResources.alt,
      mediaType: resources.mediaType,
      storageKey: resources.storageKey,
    }).from(chapterRevisionResources)
      .leftJoin(resources, eq(resources.id, chapterRevisionResources.resourceId))
      .where(inArray(chapterRevisionResources.revisionId, [...new Set(chaptersForExport.flatMap((item) => item.revisionId ? [item.revisionId] : []))]));
    const filename = filenamePart(`${work.title}-${versionLabel}`);
    const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_');

    let bytes: Uint8Array;
    const formatter = bookFormatters[format];
    try {
      const book = await loadExportBook({ work, versionLabel, modifiedAt }, chaptersForExport, resourceRows, storage);
      bytes = await formatter.serialize(book);
    } catch (error) {
      if (error instanceof ExportContentUnavailable) return c.json({ error: 'content_unavailable' }, 409);
      throw error;
    }
    c.header('Content-Type', formatter.mediaType);
    c.header('Content-Disposition', `attachment; filename="${asciiFilename}.${format}"; filename*=UTF-8''${encodeURIComponent(filename)}.${format}`);
    return c.body(Buffer.from(bytes));
  });

  return app;
}
