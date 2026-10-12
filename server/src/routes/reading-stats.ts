// Member reading history and foreground reading-time reports.
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface ReadingStatsDeps { db: NodePgDatabase }

type DayRow = { day: string | Date; firstReadChapters: number; activeSeconds: number };
type RecentRow = {
  workId: string; workTitle: string; chapterId: string; chapterLabel: string;
  firstReadAt: Date; lastReadAt: Date; chaptersRead: number;
};

const dateKey = (value: string | Date): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

export function readingStatsRoutes({ db }: ReadingStatsDeps) {
  const app = new Hono<{ Variables: { userId: string; role: string } }>();
  const requireUser: MiddlewareHandler<{ Variables: { userId: string; role: string } }> = async (c, next) => {
    if (!c.get('userId')) return c.json({ error: 'forbidden' }, 401);
    await next();
  };
  app.use('/api/me/reading-stats', requireUser);
  app.use('/api/me/reading-stats/*', requireUser);

  app.get('/api/me/reading-stats', async (c) => {
    const userId = c.get('userId');
    const isAdmin = c.get('role') === 'admin';
    const visible = sql`w.visibility <> 'removed' and (w.visibility <> 'draft' or ${isAdmin})`;
    const [totals] = (await db.execute(sql`
      select count(distinct ucr.chapter_id)::int as chapters_read,
             count(distinct ch.work_id)::int as works_read,
             coalesce((select sum(active_seconds)::int from app.user_reading_activity
                       where user_id = ${userId}), 0)::int as active_seconds
      from app.user_chapter_reads ucr
      join app.chapters ch on ch.id = ucr.chapter_id
      join app.works w on w.id = ch.work_id
      where ucr.user_id = ${userId} and ${visible}
    `)).rows as Array<{ chapters_read: number; works_read: number; active_seconds: number }>;

    const recentRows = (await db.execute(sql`
      select "workId", "workTitle", "chapterId", "chapterLabel", "firstReadAt", "lastReadAt", "chaptersRead"
      from (
        select ch.work_id as "workId", w.title as "workTitle", ch.id as "chapterId",
               ch.label_raw as "chapterLabel", ucr.first_read_at as "firstReadAt",
               ucr.last_read_at as "lastReadAt",
               (count(*) over (partition by ch.work_id))::int as "chaptersRead",
               row_number() over (partition by ch.work_id order by ucr.last_read_at desc, ch.id) as rank
        from app.user_chapter_reads ucr
        join app.chapters ch on ch.id = ucr.chapter_id
        join app.works w on w.id = ch.work_id
        where ucr.user_id = ${userId} and ${visible}
      ) recent where rank = 1
      order by "lastReadAt" desc
      limit 20
    `)).rows as RecentRow[];

    const dayRows = (await db.execute(sql`
      with days as (
        select (ucr.first_read_at at time zone 'UTC')::date as day,
               count(*)::int as first_read_chapters, 0::int as active_seconds
        from app.user_chapter_reads ucr
        join app.chapters ch on ch.id = ucr.chapter_id
        join app.works w on w.id = ch.work_id
        where ucr.user_id = ${userId} and ${visible}
          and ucr.first_read_at >= ((now() at time zone 'UTC')::date - 364)::timestamp at time zone 'UTC'
        group by 1
        union all
        select a.activity_date as day, 0::int as first_read_chapters, a.active_seconds
        from app.user_reading_activity a
        where a.user_id = ${userId}
          and a.activity_date >= (now() at time zone 'UTC')::date - 364
      )
      select day::text as day, sum(first_read_chapters)::int as "firstReadChapters",
             sum(active_seconds)::int as "activeSeconds"
      from days group by day order by day
    `)).rows as DayRow[];

    return c.json({
      totals: {
        chaptersRead: totals?.chapters_read ?? 0,
        worksRead: totals?.works_read ?? 0,
        activeSeconds: totals?.active_seconds ?? 0,
      },
      recent: recentRows.map((r) => ({
        workId: r.workId, workTitle: r.workTitle, chapterId: r.chapterId,
        chapterLabel: r.chapterLabel, firstReadAt: new Date(r.firstReadAt).toISOString(),
        lastReadAt: new Date(r.lastReadAt).toISOString(), chaptersRead: r.chaptersRead,
      })),
      // This calendar uses each chapter's first recorded read, not a full
      // visit log: the existing read table intentionally stores one row/chapter.
      days: dayRows.map((r) => ({
        date: dateKey(r.day), firstReadChapters: r.firstReadChapters,
        activeSeconds: r.activeSeconds,
      })),
      calendarTimezone: 'UTC',
    });
  });

  app.post('/api/me/reading-stats/activity', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const seconds = body?.seconds;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const userId = c.get('userId');
    const result = await db.execute(sql`
      insert into app.user_reading_activity (user_id, activity_date, active_seconds)
      values (${userId}, (now() at time zone 'UTC')::date, ${seconds})
      on conflict (user_id, activity_date) do update
        set active_seconds = least(86400, app.user_reading_activity.active_seconds + excluded.active_seconds),
            updated_at = now()
      returning active_seconds as "activeSeconds"
    `);
    const row = result.rows[0] as { activeSeconds: number } | undefined;
    return c.json({ ok: true, activeSeconds: row?.activeSeconds ?? 0 });
  });

  return app;
}
