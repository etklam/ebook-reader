import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Storage } from '../storage.ts';
import { requireAdmin } from '../http/guards.ts';
import { createRateLimiter } from '../http/rate-limit.ts';
import { splitParagraphs } from './reader.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function contentReportRoutes({ db, storage }: { db: NodePgDatabase; storage: Storage }) {
  const app = new Hono<{ Variables: { userId: string; role: string } }>();
  const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });
  app.use('/api/admin/content-reports', requireAdmin);
  app.use('/api/admin/content-reports/*', requireAdmin);

  app.post('/api/me/content-reports', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body || ![body.workId, body.chapterId, body.revisionId].every((id) => typeof id === 'string' && UUID_RE.test(id))
      || !Number.isSafeInteger(body.paragraphIndex) || body.paragraphIndex < 0
      || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1000) {
      return c.json({ error: 'invalid_report' }, 400);
    }
    const verdict = limiter.check(userId);
    if (!verdict.allowed) {
      c.header('Retry-After', String(verdict.retryAfter));
      return c.json({ error: 'report_rate_limited' }, 429);
    }
    const result = await db.execute(sql`select cr.content_key from app.works w
      join app.release_items ri on ri.release_id = w.active_release_id
      join app.chapters ch on ch.id = ri.chapter_id and ch.work_id = w.id
      join app.chapter_revisions cr on cr.id = ri.revision_id and cr.chapter_id = ch.id
      where w.id = ${body.workId} and ch.id = ${body.chapterId} and cr.id = ${body.revisionId}
        and w.visibility in ('public', 'unlisted') limit 1`);
    const row = result.rows[0] as { content_key: string } | undefined;
    if (!row) return c.json({ error: 'report_location_unavailable' }, 404);
    let paragraphs: string[];
    try { paragraphs = splitParagraphs((await storage.get(row.content_key)).toString('utf8')); }
    catch { return c.json({ error: 'content_unavailable' }, 409); }
    const paragraph = paragraphs[body.paragraphIndex];
    if (paragraph === undefined) return c.json({ error: 'invalid_paragraph' }, 400);
    const inserted = await db.execute(sql`insert into app.content_reports
      (user_id, work_id, chapter_id, revision_id, paragraph_index, excerpt, message)
      values (${userId}, ${body.workId}, ${body.chapterId}, ${body.revisionId}, ${body.paragraphIndex},
        ${paragraph.slice(0, 1000)}, ${body.message.trim()}) returning id`);
    return c.json({ id: inserted.rows[0].id }, 201);
  });

  app.get('/api/admin/content-reports', async (c) => {
    const status = c.req.query('status') ?? 'open';
    const offset = Number(c.req.query('offset') ?? 0);
    if (!['open', 'resolved'].includes(status) || !Number.isSafeInteger(offset) || offset < 0) {
      return c.json({ error: 'invalid_filter' }, 400);
    }
    const result = await db.execute(sql`select r.id, r.work_id as "workId", r.chapter_id as "chapterId",
      r.revision_id as "revisionId", r.paragraph_index as "paragraphIndex", r.excerpt, r.message,
      r.status, r.created_at as "createdAt", r.resolved_at as "resolvedAt",
      w.title as "workTitle", cr.title as "chapterTitle"
      from app.content_reports r join app.works w on w.id = r.work_id
      join app.chapter_revisions cr on cr.id = r.revision_id
      where r.status = ${status} order by r.created_at desc, r.id desc limit 50 offset ${offset}`);
    return c.json({ reports: result.rows, limit: 50, offset });
  });

  app.patch('/api/admin/content-reports/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!UUID_RE.test(id) || body?.status !== 'resolved') return c.json({ error: 'invalid_report' }, 400);
    const result = await db.execute(sql`update app.content_reports set status = 'resolved',
      resolved_at = coalesce(resolved_at, now()) where id = ${id} returning id`);
    if (!result.rows.length) return c.json({ error: 'report_not_found' }, 404);
    return c.json({ ok: true });
  });
  return app;
}
