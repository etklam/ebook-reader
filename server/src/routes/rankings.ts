import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { randomBytes, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { cookieOpts } from '../auth/session.ts';
import { clientIp, createRateLimiter, rateLimit } from '../http/rate-limit.ts';

const PERIOD_DAYS = { week: 7, month: 30, year: 365, all: null } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISITOR_COOKIE = 'ebook_click_visitor';

export function rankingRoutes({ db, trustProxy }: { db: NodePgDatabase; trustProxy: boolean }) {
  const app = new Hono<{ Variables: { userId: string; role: string } }>();
  app.use('/api/works/:workId/click', rateLimit({
    limiter: createRateLimiter({ windowMs: 60_000, max: 60 }),
    keyOf: (c) => clientIp(c, trustProxy), errorCode: 'too_many_requests',
  }));
  app.post('/api/works/:workId/click', async (c) => {
    const workId = c.req.param('workId');
    if (!UUID_RE.test(workId)) return c.json({ error: 'work_not_found' }, 404);
    // Editorial previews and admin checks never contribute to popularity.
    if (c.get('role') === 'admin') return c.json({ counted: false });
    let visitor = getCookie(c, VISITOR_COOKIE);
    if (!visitor || !/^[A-Za-z0-9_-]{43}$/.test(visitor)) {
      visitor = randomBytes(32).toString('base64url');
      setCookie(c, VISITOR_COOKIE, visitor, { ...cookieOpts(), maxAge: 365 * 86400 });
    }
    const hash = createHash('sha256').update(`${workId}:${visitor}`).digest('hex');
    const result = await db.execute(sql`
      insert into app.work_clicks (work_id, visitor_hash, day)
      select id, ${hash}, (now() at time zone 'Asia/Taipei')::date
      from app.works where id = ${workId} and visibility = 'public' and active_release_id is not null
      on conflict do nothing returning work_id`);
    return c.json({ counted: result.rows.length > 0 });
  });

  app.get('/api/rankings', async (c) => {
    const period = c.req.query('period') ?? 'week';
    const type = c.req.query('type') ?? 'clicks';
    if (type !== 'clicks' && type !== 'favorites') return c.json({ error: 'invalid_type' }, 400);
    if (!Object.hasOwn(PERIOD_DAYS, period)) return c.json({ error: 'invalid_period' }, 400);
    const serialStatus = c.req.query('serialStatus') || null;
    const categoryId = c.req.query('categoryId') || null;
    if (serialStatus && !['ongoing', 'completed', 'paused'].includes(serialStatus)) return c.json({ error: 'invalid_filter', field: 'serialStatus' }, 400);
    if (categoryId && !UUID_RE.test(categoryId)) return c.json({ error: 'invalid_filter', field: 'categoryId' }, 400);
    const statusFilter = serialStatus ? sql`w.serial_status = ${serialStatus}` : sql`true`;
    const categoryFilter = categoryId ? sql`exists (select 1 from app.work_categories wc join app.categories ct on ct.id = wc.category_id where wc.work_id = w.id and ct.is_active and wc.category_id = ${categoryId}::uuid)` : sql`true`;
    const days = PERIOD_DAYS[period as keyof typeof PERIOD_DAYS];
    const source = type === 'favorites' ? sql`app.user_library` : sql`app.work_clicks`;
    const day = type === 'favorites' ? sql`(v.created_at at time zone 'Asia/Taipei')::date` : sql`v.day`;
    const range = days === null ? sql`true` : sql`${day} >= (now() at time zone 'Asia/Taipei')::date - ${days - 1}::integer`;
    const result = await db.execute(sql`
      select w.id, w.public_id, w.title, w.author, w.work_type, w.serial_status, r.chapter_count,
             count(*)::text as score
      from ${source} v
      join app.works w on w.id = v.work_id
      join app.work_releases r on r.id = w.active_release_id and r.work_id = w.id
      where ${range}
        and w.visibility = 'public' and ${statusFilter} and ${categoryFilter}
      group by w.id, w.public_id, w.title, w.author, w.work_type, w.serial_status, r.chapter_count
      order by count(*) desc, w.title asc, w.id asc limit 50`);
    return c.json({ type, period, days, timezone: 'Asia/Taipei', works: result.rows.map((row) => ({
      id: row.id, publicId: row.public_id, title: row.title, author: row.author, workType: row.work_type,
      serialStatus: row.serial_status, chapterCount: row.chapter_count, clicks: type === 'clicks' ? Number(row.score) : 0,
      favorites: type === 'favorites' ? Number(row.score) : 0,
    })) });
  });
  return app;
}
