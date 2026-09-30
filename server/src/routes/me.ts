// Member routes (/api/me, M6 §27-§44): library, follows + update markers,
// reading progress (optimistic concurrency), chapter reads, bookmarks,
// reader preferences. Every route requires a session; ownership comes from
// the session user id — never from the request body.
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  bookmarks, chapters, chapterRevisions, readerPreferences,
  readingProgress, userChapterReads, userFollows, userLibrary as library,
  works, workReleases,
} from '../db/schema.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routeId = (c: Context): string => c.req.param('workId') as string;

export interface MeDeps {
  db: NodePgDatabase;
}

export function meRoutes(deps: MeDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  const requireUser: MiddlewareHandler<{ Variables: { userId: string; role: string } }> = async (c, next) => {
    if (!c.get('userId')) return c.json({ error: 'forbidden' }, 401);
    await next();
  };
  app.use('/api/me/*', requireUser);

  const userIdOf = (c: Context<{ Variables: { userId: string; role: string } }>): string => c.get('userId');

  // resolve a work the user may reference: exists + (public/unlisted, or the
  // user is admin who may organize drafts)
  const visibleWork = async (id: string, role: string) => {
    if (!UUID_RE.test(id)) return null;
    const [w] = await db.select().from(works).where(eq(works.id, id)).limit(1);
    if (!w) return null;
    if (w.visibility === 'removed') return null;
    if (w.visibility === 'draft' && role !== 'admin') return null;
    return w;
  };

  // --- library / favorites (§27): independent from follows/progress/reads ----
  app.get('/api/me/library', async (c) => {
    const userId = userIdOf(c);
    const rows = await db.select({
      workId: library.workId,
      title: works.title,
      author: works.author,
      workType: works.workType,
      serialStatus: works.serialStatus,
      activeReleaseId: works.activeReleaseId,
      addedAt: library.createdAt,
      updatedAt: library.updatedAt,
      // continue reading (§39): stable chapter-id based, never max position
      progressChapterId: readingProgress.chapterId,
      progressParagraphIndex: readingProgress.paragraphIndex,
      progressUpdatedAt: readingProgress.updatedAt,
      lastSeenVersion: userFollows.lastSeenReleaseVersion,
      latestVersion: sql<number | null>`(select max(version)::int from app.work_releases r where r.work_id = ${library.workId})`,
      newChapters: sql<number>`coalesce((
        select sum(jsonb_array_length(e.new_chapter_ids))::int
        from app.publication_events e
        where e.work_id = ${library.workId}
          and e.release_version > coalesce((select f.last_seen_release_version from app.user_follows f
                                            where f.user_id = ${userId} and f.work_id = ${library.workId}), 0)), 0)`,
    }).from(library)
      .innerJoin(works, eq(works.id, library.workId))
      .leftJoin(readingProgress, and(eq(readingProgress.userId, userId), eq(readingProgress.workId, library.workId)))
      .leftJoin(userFollows, and(eq(userFollows.userId, userId), eq(userFollows.workId, library.workId)))
      .where(eq(library.userId, userId))
      .orderBy(desc(library.updatedAt));
    return c.json({
      works: rows.map((r) => ({
        workId: r.workId,
        title: r.title,
        author: r.author,
        workType: r.workType,
        serialStatus: r.serialStatus,
        hasUpdate: r.lastSeenVersion !== null && r.latestVersion !== null && r.latestVersion > r.lastSeenVersion,
        newChapterCount: r.newChapters,
        continueChapterId: r.progressChapterId,
        continueParagraphIndex: r.progressParagraphIndex,
        lastReadAt: r.progressUpdatedAt?.toISOString() ?? null,
        addedAt: r.addedAt.toISOString(),
      })),
    });
  });

  app.put('/api/me/library/:workId', async (c) => {
    const work = await visibleWork(routeId(c), c.get('role'));
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    const userId = userIdOf(c);
    await db.insert(library).values({ userId, workId: work.id })
      .onConflictDoUpdate({ target: [library.userId, library.workId], set: { updatedAt: new Date() } });
    return c.json({ ok: true });
  });

  // removing a favorite deletes ONLY the library row (§27)
  app.delete('/api/me/library/:workId', async (c) => {
    const userId = userIdOf(c);
    await db.delete(library).where(and(eq(library.userId, userId), eq(library.workId, routeId(c))));
    return c.json({ ok: true });
  });

  // --- follows (§28, §37, §38) ------------------------------------------------
  app.get('/api/me/follows', async (c) => {
    const userId = userIdOf(c);
    const rows = await db.select({
      workId: userFollows.workId,
      title: works.title,
      serialStatus: works.serialStatus,
      lastSeenVersion: userFollows.lastSeenReleaseVersion,
      latestVersion: sql<number | null>`(select max(version)::int from app.work_releases r where r.work_id = ${userFollows.workId})`,
      newChapters: sql<number>`coalesce((
        select sum(jsonb_array_length(e.new_chapter_ids))::int
        from app.publication_events e
        where e.work_id = ${userFollows.workId} and e.release_version > ${userFollows.lastSeenReleaseVersion}), 0)`,
    }).from(userFollows)
      .innerJoin(works, eq(works.id, userFollows.workId))
      .where(and(eq(userFollows.userId, userId), sql`${works.visibility} in ('public','unlisted')`))
      .orderBy(desc(userFollows.followedAt));
    return c.json({
      follows: rows.map((r) => ({
        workId: r.workId,
        title: r.title,
        hasUpdate: r.latestVersion !== null && r.latestVersion > r.lastSeenVersion,
        newChapterCount: r.newChapters,
        lastSeenVersion: r.lastSeenVersion,
        latestVersion: r.latestVersion,
      })),
    });
  });

  app.put('/api/me/follows/:workId', async (c) => {
    const work = await visibleWork(routeId(c), c.get('role'));
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    // a fresh follow starts having seen the CURRENT release — following an
    // existing work is not itself an update (§37)
    const userId = userIdOf(c);
    const [latest] = await db.select({ v: sql<number>`coalesce(max(${workReleases.version}), 0)::int` })
      .from(workReleases).where(eq(workReleases.workId, work.id));
    await db.insert(userFollows).values({ userId, workId: work.id, lastSeenReleaseVersion: latest.v })
      .onConflictDoNothing();
    return c.json({ ok: true, lastSeenVersion: latest.v });
  });

  app.delete('/api/me/follows/:workId', async (c) => {
    const userId = userIdOf(c);
    await db.delete(userFollows).where(and(eq(userFollows.userId, userId), eq(userFollows.workId, routeId(c))));
    return c.json({ ok: true });
  });

  // mark updates seen: deterministic policy — opening the work detail/reader
  // marks seen (§38). Optional explicit version for tests/tools.
  app.post('/api/me/follows/:workId/seen', async (c) => {
    const workId = routeId(c);
    const userId = userIdOf(c);
    const body = await c.req.json().catch(() => ({}));
    const version = Number.isInteger(body?.releaseVersion)
      ? (body.releaseVersion as number)
      : (await db.select({ v: sql<number>`coalesce(max(${workReleases.version}), 0)::int` })
        .from(workReleases).where(eq(workReleases.workId, workId)))[0].v;
    await db.update(userFollows)
      .set({ lastSeenReleaseVersion: version })
      .where(and(eq(userFollows.userId, userId), eq(userFollows.workId, workId)));
    return c.json({ ok: true, lastSeenVersion: version });
  });

  // --- reading progress (§29/§30): optimistic concurrency ---------------------
  app.get('/api/me/progress/:workId', async (c) => {
    const userId = userIdOf(c);
    const [row] = await db.select().from(readingProgress)
      .where(and(eq(readingProgress.userId, userId), eq(readingProgress.workId, routeId(c)))).limit(1);
    if (!row) return c.json({ progress: null });
    return c.json({
      progress: {
        chapterId: row.chapterId,
        revisionId: row.revisionId,
        paragraphIndex: row.paragraphIndex,
        fraction: row.fraction,
        syncVersion: row.syncVersion,
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  });

  app.put('/api/me/progress/:workId', async (c) => {
    const work = await visibleWork(routeId(c), c.get('role'));
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    const userId = userIdOf(c);
    const body = await c.req.json().catch(() => ({}));
    const { chapterId, revisionId, paragraphIndex, fraction, baseVersion } = body ?? {};
    if (typeof chapterId !== 'string' || typeof revisionId !== 'string'
      || !Number.isInteger(paragraphIndex) || (paragraphIndex as number) < 0
      || !Number.isInteger(baseVersion) || (baseVersion as number) < 0) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (fraction !== undefined && fraction !== null && (typeof fraction !== 'number' || fraction < 0 || fraction > 1)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // the saved revision must belong to the saved chapter (spot check)
    const [rev] = await db.select({ chapterId: chapterRevisions.chapterId })
      .from(chapterRevisions).where(eq(chapterRevisions.id, revisionId)).limit(1);
    if (!rev || rev.chapterId !== chapterId) return c.json({ error: 'invalid_request' }, 400);

    const updated = await db.update(readingProgress).set({
      chapterId, revisionId, paragraphIndex,
      fraction: fraction ?? null,
      syncVersion: sql`${readingProgress.syncVersion} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(readingProgress.userId, userId),
      eq(readingProgress.workId, work.id),
      eq(readingProgress.syncVersion, baseVersion),
    )).returning({ syncVersion: readingProgress.syncVersion });
    if (updated.length > 0) {
      return c.json({ ok: true, syncVersion: updated[0].syncVersion });
    }

    // no row at that version: fresh insert (baseVersion 0) or a real conflict
    if (baseVersion === 0) {
      const inserted = await db.insert(readingProgress).values({
        userId, workId: work.id, chapterId, revisionId, paragraphIndex,
        fraction: fraction ?? null,
      }).onConflictDoNothing().returning({ syncVersion: readingProgress.syncVersion });
      if (inserted.length > 0) return c.json({ ok: true, syncVersion: inserted[0].syncVersion });
    }
    const [current] = await db.select().from(readingProgress)
      .where(and(eq(readingProgress.userId, userId), eq(readingProgress.workId, work.id))).limit(1);
    return c.json({
      error: 'progress_conflict',
      progress: current ? {
        chapterId: current.chapterId,
        revisionId: current.revisionId,
        paragraphIndex: current.paragraphIndex,
        fraction: current.fraction,
        syncVersion: current.syncVersion,
        updatedAt: current.updatedAt.toISOString(),
      } : null,
    }, 409);
  });

  // --- chapter reads (§32/§33): stable chapter id, separate from progress -----
  app.post('/api/me/reads', async (c) => {
    const userId = userIdOf(c);
    const body = await c.req.json().catch(() => ({}));
    const chapterId = typeof body?.chapterId === 'string' ? body.chapterId : '';
    if (!UUID_RE.test(chapterId)) return c.json({ error: 'invalid_request' }, 400);
    const [chapter] = await db.select({ workId: chapters.workId })
      .from(chapters).where(eq(chapters.id, chapterId)).limit(1);
    if (!chapter) return c.json({ error: 'chapter_not_found' }, 404);
    const work = await visibleWork(chapter.workId, c.get('role'));
    if (!work) return c.json({ error: 'forbidden' }, 403);
    await db.insert(userChapterReads).values({ userId, chapterId })
      .onConflictDoUpdate({
        target: [userChapterReads.userId, userChapterReads.chapterId],
        set: { lastReadAt: new Date() },
      });
    return c.json({ ok: true });
  });

  app.get('/api/me/reads', async (c) => {
    const userId = userIdOf(c);
    const workId = c.req.query('workId') ?? '';
    const rows = await db.select({ chapterId: userChapterReads.chapterId, lastReadAt: userChapterReads.lastReadAt })
      .from(userChapterReads)
      .where(workId && UUID_RE.test(workId)
        ? and(eq(userChapterReads.userId, userId),
            sql`${userChapterReads.chapterId} in (select id from app.chapters where work_id = ${workId})`)
        : eq(userChapterReads.userId, userId))
      .orderBy(desc(userChapterReads.lastReadAt))
      .limit(5000);
    return c.json({ reads: rows.map((r) => ({ chapterId: r.chapterId, lastReadAt: r.lastReadAt.toISOString() })) });
  });

  // --- bookmarks (§34/§35): multiple per work/chapter, owner-only -------------
  app.get('/api/me/bookmarks', async (c) => {
    const userId = userIdOf(c);
    const workId = c.req.query('workId');
    const rows = await db.select({
      id: bookmarks.id,
      workId: bookmarks.workId,
      workTitle: works.title,
      chapterId: bookmarks.chapterId,
      chapterLabel: chapters.labelRaw,
      revisionId: bookmarks.revisionId,
      paragraphIndex: bookmarks.paragraphIndex,
      note: bookmarks.note,
      createdAt: bookmarks.createdAt,
    }).from(bookmarks)
      .innerJoin(works, eq(works.id, bookmarks.workId))
      .innerJoin(chapters, eq(chapters.id, bookmarks.chapterId))
      .where(workId && UUID_RE.test(workId)
        ? and(eq(bookmarks.userId, userId), eq(bookmarks.workId, workId))
        : eq(bookmarks.userId, userId))
      .orderBy(desc(bookmarks.updatedAt))
      .limit(500);
    return c.json({
      bookmarks: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  });

  app.post('/api/me/bookmarks', async (c) => {
    const userId = userIdOf(c);
    const body = await c.req.json().catch(() => ({}));
    const { workId, chapterId, revisionId, paragraphIndex, note } = body ?? {};
    if (typeof workId !== 'string' || typeof chapterId !== 'string'
      || typeof revisionId !== 'string' || !Number.isInteger(paragraphIndex) || (paragraphIndex as number) < 0) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const work = await visibleWork(workId, c.get('role'));
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    // the frozen revision must belong to the bookmarked chapter (§35)
    const [rev] = await db.select({ chapterId: chapterRevisions.chapterId })
      .from(chapterRevisions).where(eq(chapterRevisions.id, revisionId)).limit(1);
    if (!rev || rev.chapterId !== chapterId) return c.json({ error: 'invalid_request' }, 400);
    const [row] = await db.insert(bookmarks).values({
      userId, workId, chapterId, revisionId,
      paragraphIndex, note: typeof note === 'string' ? note.slice(0, 500) : '',
    }).returning({ id: bookmarks.id });
    return c.json({ id: row.id }, 201);
  });

  app.patch('/api/me/bookmarks/:id', async (c) => {
    const userId = userIdOf(c);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'bookmark_not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body?.note === 'string') patch.note = body.note.slice(0, 500);
    if (Number.isInteger(body?.paragraphIndex) && (body.paragraphIndex as number) >= 0) patch.paragraphIndex = body.paragraphIndex;
    if (Object.keys(patch).length === 1) return c.json({ error: 'invalid_request' }, 400);
    const [row] = await db.update(bookmarks).set(patch)
      .where(and(eq(bookmarks.id, id), eq(bookmarks.userId, userId)))
      .returning({ id: bookmarks.id });
    if (!row) return c.json({ error: 'bookmark_not_found' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/api/me/bookmarks/:id', async (c) => {
    const userId = userIdOf(c);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'bookmark_not_found' }, 404);
    const deleted = await db.delete(bookmarks)
      .where(and(eq(bookmarks.id, id), eq(bookmarks.userId, userId)))
      .returning({ id: bookmarks.id });
    if (deleted.length === 0) return c.json({ error: 'bookmark_not_found' }, 404);
    return c.json({ ok: true });
  });

  // --- reader preferences (§36) ------------------------------------------------
  app.get('/api/me/reader-preferences', async (c) => {
    const userId = userIdOf(c);
    const [row] = await db.select().from(readerPreferences).where(eq(readerPreferences.userId, userId)).limit(1);
    if (!row) return c.json({ preferences: null });
    return c.json({
      preferences: {
        theme: row.theme,
        fontSize: row.fontSize,
        lineHeight: row.lineHeight,
        paragraphSpacing: row.paragraphSpacing,
        conversion: row.conversionMode,
        mode: row.readingMode,
        updatedAt: row.updatedAt.toISOString(),
      },
    });
  });

  app.put('/api/me/reader-preferences', async (c) => {
    const userId = userIdOf(c);
    const body = await c.req.json().catch(() => ({}));
    const theme = ['light', 'sepia', 'dark'].includes(body?.theme) ? body.theme : null;
    const conversion = ['original', 't', 'cn'].includes(body?.conversion) ? body.conversion : null;
    const mode = ['scroll', 'paginated'].includes(body?.mode) ? body.mode : null;
    const fontSize = Number(body?.fontSize);
    const lineHeight = Number(body?.lineHeight);
    const paragraphSpacing = Number(body?.paragraphSpacing);
    if (!theme || !conversion || !mode
      || !Number.isInteger(fontSize) || fontSize < 14 || fontSize > 28
      || !(lineHeight >= 1.4 && lineHeight <= 2.6)
      || !(paragraphSpacing >= 0 && paragraphSpacing <= 3)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    await db.insert(readerPreferences).values({
      userId,
      theme, conversionMode: conversion, readingMode: mode,
      fontSize, lineHeight, paragraphSpacing,
    }).onConflictDoUpdate({
      target: readerPreferences.userId,
      set: {
        theme, conversionMode: conversion, readingMode: mode,
        fontSize, lineHeight, paragraphSpacing, updatedAt: new Date(),
      },
    });
    return c.json({ ok: true });
  });

  return app;
}
