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

export interface SearchExportRoutesDeps {
  db: NodePgDatabase;
  storage: Storage;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_RE = /\[\[img:([0-9a-f]{64})\]\]/gi;
const MAX_RESULTS = 50;

function noImages(body: string): string {
  return body.replace(IMAGE_RE, '');
}

function snippet(body: string, variants: readonly string[]): { snippet: string; matchStart: number; matchLength: number } | null {
  const text = noImages(body).replace(/\s+/g, ' ').trim();
  const lower = text.toLocaleLowerCase();
  let matchAt = -1;
  let matchLength = 0;
  for (const variant of variants) {
    const needle = variant.toLocaleLowerCase();
    const at = lower.indexOf(needle);
    if (at >= 0 && (matchAt < 0 || at < matchAt)) {
      matchAt = at;
      matchLength = needle.length;
    }
  }
  if (matchAt < 0) return null;
  const start = Math.max(0, matchAt - 72);
  const end = Math.min(text.length, matchAt + matchLength + 112);
  const prefix = start > 0 ? '…' : '';
  const result = text.slice(start, end);
  return {
    snippet: `${prefix}${result}${end < text.length ? '…' : ''}`,
    matchStart: prefix.length + matchAt - start,
    matchLength,
  };
}

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

  // Search follows reader visibility and the ACTIVE release. Draft head is
  // searchable only to Admin; historical releases are never exposed here.
  app.get('/api/reader/works/:id/search', async (c) => {
    const workId = c.req.param('id');
    if (!UUID_RE.test(workId)) return c.json({ error: 'work_not_found' }, 404);
    const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
    if (!work || work.visibility === 'removed') return c.json({ error: 'work_not_found' }, 404);
    const admin = c.get('role') === 'admin';
    if (work.visibility === 'draft' && !admin) return c.json({ error: 'forbidden' }, 403);

    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    if (!q) return c.json({ error: 'query_required' }, 400);
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

    let total = 0;
    const results: Array<{
      chapterId: string; labelRaw: string; title: string; snippet: string;
      matchStart: number; matchLength: number; paragraphIndex: number; href: string;
    }> = [];
    // ponytail: scan immutable chapter objects on demand; a persistent index is
    // justified only once the catalogue size makes full-volume scans too slow.
    let contentUnavailable = false;
    await Promise.all(Array.from({ length: Math.min(8, rows.length) }, async (_, worker) => {
      for (let index = worker; index < rows.length; index += Math.min(8, rows.length)) {
        const row = rows[index];
        let body: string;
        try { body = (await storage.get(row.contentKey)).toString('utf8'); }
        catch { contentUnavailable = true; continue; }
        const paragraphs = body.split('\n\n');
        let paragraphIndex = paragraphs.findIndex((paragraph) => snippet(paragraph, variants) !== null);
        const found = paragraphIndex >= 0 ? snippet(paragraphs[paragraphIndex], variants) : snippet(row.title, variants);
        if (!found) continue;
        if (paragraphIndex < 0) paragraphIndex = 0;
        total += 1;
        results.push({
          chapterId: row.chapterId, labelRaw: row.labelRaw, title: row.title,
          ...found, paragraphIndex,
          href: `/read/${workId}/${row.chapterId}#p=${paragraphIndex}&rev=${row.revisionId}`,
        });
      }
    }));
    if (contentUnavailable) return c.json({ error: 'content_unavailable' }, 409);
    // workers append out of order; restore the work's editorial/release order.
    const order = new Map(rows.map((row, index) => [row.chapterId, index]));
    results.sort((a, b) => (order.get(a.chapterId) ?? 0) - (order.get(b.chapterId) ?? 0));
    const truncated = total > MAX_RESULTS;
    return c.json({ query: q, total, truncated, results: results.slice(0, MAX_RESULTS) });
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
