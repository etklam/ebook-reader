// Member routes (/api/me, M6 §27-§44): library, follows + update markers,
// reading progress (optimistic concurrency), chapter reads, bookmarks,
// reader preferences. Every route requires a session; ownership comes from
// the session user id — never from the request body.
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { isNull, and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { decodeCursor, encodeCursor, filterFingerprint } from '../catalog/cursor.ts';
import {
  bookmarks, chapters, chapterRevisions, readerPreferences,
  readingProgress, userChapterReads, userFollows, userLibrary as library,
  works, workReleases,
} from '../db/schema.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routeId = (c: Context): string => c.req.param('workId') as string;
const READING_STATUSES = ['want', 'reading', 'finished', 'paused'] as const;
type ReadingStatus = typeof READING_STATUSES[number];
const isReadingStatus = (value: unknown): value is ReadingStatus =>
  READING_STATUSES.some((status) => status === value);

export function parseLibraryMetadata(body: unknown): { readingStatus?: ReadingStatus; groupName?: string | null } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['readingStatus', 'groupName'].includes(key)) || Object.keys(data).length === 0) return null;
  if ('readingStatus' in data && !isReadingStatus(data.readingStatus)) return null;
  if ('groupName' in data && data.groupName !== null &&
    (typeof data.groupName !== 'string' || data.groupName.trim().length > 40)) return null;
  return {
    ...('readingStatus' in data ? { readingStatus: data.readingStatus as ReadingStatus } : {}),
    ...('groupName' in data ? { groupName: (data.groupName as string | null)?.trim() || null } : {}),
  };
}

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

  // Reject a malformed :workId before it reaches a uuid column. Without this
  // the driver raises 22P02 and the request becomes a 500 — an unhandled
  // server error for what is plainly a bad client path.
  const validWorkId: MiddlewareHandler<{ Variables: { userId: string; role: string } }> = async (c, next) => {
    if (!UUID_RE.test(routeId(c))) return c.json({ error: 'work_not_found' }, 404);
    await next();
  };
  for (const path of ['/api/me/library/:workId', '/api/me/follows/:workId',
    '/api/me/follows/:workId/seen', '/api/me/progress/:workId',
    '/api/me/works/:workId/state']) {
    app.use(path, validWorkId);
  }

  // A chapter reference must belong to the work it is filed under, and the
  // revision to that chapter. Checking the revision alone let a client store
  // progress for work A pointing at a chapter of work B, which then drives
  // "continue reading" in the library straight into the wrong book.
  const chapterBelongsTo = async (workId: string, chapterId: string, revisionId: string): Promise<boolean> => {
    if (!UUID_RE.test(chapterId) || !UUID_RE.test(revisionId)) return false;
    const [row] = await db.select({ workId: chapters.workId })
      .from(chapterRevisions)
      .innerJoin(chapters, eq(chapters.id, chapterRevisions.chapterId))
      .where(and(eq(chapterRevisions.id, revisionId), eq(chapterRevisions.chapterId, chapterId), isNull(chapters.mergedIntoChapterId),
        sql`(${chapters.deletedAt} is null or exists (select 1 from app.release_items ri
          join app.works w on w.id = ${chapters.workId} and w.active_release_id = ri.release_id
          where ri.chapter_id = ${chapters.id} and ri.revision_id = ${revisionId}))`))
      .limit(1);
    return row?.workId === workId;
  };

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
  // Keyset-paginated like the public catalog: the shelf used to return every
  // row, so a member with thousands of favourites got an unbounded response.
  // Ordered by (updatedAt desc, workId asc); the cursor carries both.
  app.get('/api/me/library', async (c) => {
    const userId = userIdOf(c);
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));
    const readingStatus = c.req.query('readingStatus');
    const groupName = c.req.query('groupName')?.trim();
    if (readingStatus !== undefined && !isReadingStatus(readingStatus)) return c.json({ error: 'invalid_reading_status' }, 400);
    if (groupName !== undefined && groupName.length > 40) return c.json({ error: 'invalid_group_name' }, 400);
    const fingerprint = filterFingerprint([`library=${userId}`, `status=${readingStatus ?? ''}`, `group=${groupName === undefined ? '*' : JSON.stringify(groupName)}`]);
    const scope: SQL[] = [eq(library.userId, userId)];
    if (readingStatus) scope.push(eq(library.readingStatus, readingStatus));
    if (groupName !== undefined) scope.push(groupName ? eq(library.groupName, groupName) : isNull(library.groupName));
    const rawCursor = c.req.query('cursor');
    if (rawCursor) {
      const decoded = decodeCursor(rawCursor, fingerprint);
      if (!decoded.ok) return c.json({ error: decoded.error }, 400);
      scope.push(sql`(${library.updatedAt} < ${decoded.cursor.k}::timestamptz
        or (${library.updatedAt} = ${decoded.cursor.k}::timestamptz
            and ${library.workId} > ${decoded.cursor.id}::uuid))`);
    }
    const rows = await db.select({
      sortValue: sql<string>`to_char(${library.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      workId: library.workId,
      title: works.title,
      author: works.author,
      workType: works.workType,
      serialStatus: works.serialStatus,
      activeReleaseId: works.activeReleaseId,
      addedAt: library.createdAt,
      updatedAt: library.updatedAt,
      readingStatus: library.readingStatus,
      groupName: library.groupName,
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
      .where(and(...scope))
      .orderBy(desc(library.updatedAt), asc(library.workId))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last
      ? encodeCursor({ v: 1, f: fingerprint, k: last.sortValue, id: last.workId })
      : null;
    // Group options cover the entire shelf, including rows beyond this page.
    const groups = await db.selectDistinct({ name: library.groupName }).from(library)
      .where(and(eq(library.userId, userId), sql`${library.groupName} is not null`))
      .orderBy(asc(library.groupName));
    return c.json({
      limit,
      nextCursor,
      groups: groups.map((group) => group.name),
      works: page.map((r) => ({
        workId: r.workId,
        title: r.title,
        author: r.author,
        workType: r.workType,
        serialStatus: r.serialStatus,
        following: r.lastSeenVersion !== null,
        lastSeenVersion: r.lastSeenVersion,
        hasUpdate: r.lastSeenVersion !== null && r.latestVersion !== null && r.latestVersion > r.lastSeenVersion,
        newChapterCount: r.newChapters,
        continueChapterId: r.progressChapterId,
        continueParagraphIndex: r.progressParagraphIndex,
        lastReadAt: r.progressUpdatedAt?.toISOString() ?? null,
        addedAt: r.addedAt.toISOString(),
        readingStatus: r.readingStatus,
        groupName: r.groupName,
      })),
    });
  });

  // Per-work member state for the work-detail page. The page used to fetch the
  // entire library and the entire follow list to answer a single-work question,
  // which broke as soon as the shelf became paginated — and was an O(shelf)
  // query for one row even before that.
  app.get('/api/me/works/:workId/state', validWorkId, async (c) => {
    const userId = userIdOf(c);
    const workId = routeId(c);
    const [row] = await db.select({
      inLibrary: sql<boolean>`exists (select 1 from app.user_library l
        where l.user_id = ${userId} and l.work_id = ${workId})`,
      following: sql<boolean>`exists (select 1 from app.user_follows f
        where f.user_id = ${userId} and f.work_id = ${workId})`,
      lastSeenVersion: sql<number | null>`(select f.last_seen_release_version from app.user_follows f
        where f.user_id = ${userId} and f.work_id = ${workId})`,
      latestVersion: sql<number | null>`(select max(r.version)::int from app.work_releases r
        where r.work_id = ${workId})`,
      newChapterCount: sql<number>`coalesce((
        select sum(jsonb_array_length(e.new_chapter_ids))::int
        from app.publication_events e
        where e.work_id = ${workId}
          and e.release_version > coalesce((select f.last_seen_release_version from app.user_follows f
                                            where f.user_id = ${userId} and f.work_id = ${workId}), 0)), 0)`,
    }).from(sql`(select 1) as one`);
    return c.json({
      inLibrary: row.inLibrary,
      following: row.following,
      lastSeenVersion: row.lastSeenVersion,
      latestVersion: row.latestVersion,
      // only meaningful while following — matches the follow-list semantics
      newChapterCount: row.following ? row.newChapterCount : 0,
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

  app.patch('/api/me/library/:workId', async (c) => {
    const metadata = parseLibraryMetadata(await c.req.json().catch(() => null));
    if (!metadata) return c.json({ error: 'invalid_library_metadata' }, 400);
    const [entry] = await db.update(library).set({ ...metadata, updatedAt: new Date() })
      .where(and(eq(library.userId, userIdOf(c)), eq(library.workId, routeId(c))))
      .returning({ workId: library.workId });
    if (!entry) return c.json({ error: 'library_entry_not_found' }, 404);
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
    const [{ v: latest }] = await db.select({ v: sql<number>`coalesce(max(${workReleases.version}), 0)::int` })
      .from(workReleases).where(eq(workReleases.workId, workId));
    // An explicit version is clamped to what actually exists. Unclamped, a
    // client could post releaseVersion: 999999999 and permanently suppress its
    // own update markers — every future release would compare as already seen.
    const requested = Number.isInteger(body?.releaseVersion) ? (body.releaseVersion as number) : latest;
    if (requested < 0) return c.json({ error: 'invalid_request' }, 400);
    const version = Math.min(requested, latest);
    const updated = await db.update(userFollows)
      .set({ lastSeenReleaseVersion: version })
      .where(and(eq(userFollows.userId, userId), eq(userFollows.workId, workId)))
      .returning({ workId: userFollows.workId });
    // Not following is a no-op, not an error: the web client marks seen on
    // every work-detail open (§38) and a 404 there would be pure noise. The
    // response says plainly whether anything was updated.
    if (updated.length === 0) return c.json({ ok: true, following: false, lastSeenVersion: null });
    return c.json({ ok: true, following: true, lastSeenVersion: version });
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
    // chapter must be in THIS work and the revision must be that chapter's
    if (!(await chapterBelongsTo(work.id, chapterId, revisionId))) {
      return c.json({ error: 'invalid_request' }, 400);
    }

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
      .from(chapters).where(and(eq(chapters.id, chapterId), isNull(chapters.mergedIntoChapterId),
        sql`(${chapters.deletedAt} is null or exists (select 1 from app.release_items ri
          join app.works w on w.id = ${chapters.workId} and w.active_release_id = ri.release_id
          where ri.chapter_id = ${chapters.id}))`)).limit(1);
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
    // an unparseable workId used to fall through to "no filter" and return the
    // user's entire read history — silently widening a requested filter is
    // exactly what §03A forbids, so it is now an explicit error
    if (workId && !UUID_RE.test(workId)) return c.json({ error: 'invalid_filter', field: 'workId' }, 400);
    const rows = await db.select({ chapterId: userChapterReads.chapterId, lastReadAt: userChapterReads.lastReadAt })
      .from(userChapterReads)
      .where(workId
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
    // same rule as /api/me/reads: never widen a filter the caller asked for
    if (workId && !UUID_RE.test(workId)) return c.json({ error: 'invalid_filter', field: 'workId' }, 400);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(c.req.query('limit')) || 100)));
    const offset = Math.max(0, Math.floor(Number(c.req.query('offset')) || 0));
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) return c.json({ error: 'invalid_filter' }, 400);
    const condition = workId
      ? and(eq(bookmarks.userId, userId), eq(bookmarks.workId, workId))
      : eq(bookmarks.userId, userId);
    const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(bookmarks).where(condition);
    // Filter choices cover every bookmark owned by this member, independent of the page/filter.
    const workOptions = await db.selectDistinct({ id: works.id, title: works.title }).from(bookmarks)
      .innerJoin(works, eq(works.id, bookmarks.workId)).where(eq(bookmarks.userId, userId))
      .orderBy(asc(works.title), asc(works.id));
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
      .where(condition)
      .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
      .limit(limit).offset(offset);
    return c.json({
      total: count.total, works: workOptions, limit, offset,
      nextOffset: offset + limit < count.total ? offset + limit : null,
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
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) return c.json({ error: 'invalid_note' }, 400);
    const work = await visibleWork(workId, c.get('role'));
    if (!work) return c.json({ error: 'work_not_found' }, 404);
    // the frozen revision must belong to the bookmarked chapter, and that
    // chapter to this work (§35)
    if (!(await chapterBelongsTo(work.id, chapterId, revisionId))) {
      return c.json({ error: 'invalid_request' }, 400);
    }
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
    if (body?.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) return c.json({ error: 'invalid_note' }, 400);
    if (typeof body?.note === 'string') patch.note = body.note;
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
    const theme = ['light', 'sepia', 'dark', 'system'].includes(body?.theme) ? body.theme : null;
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
