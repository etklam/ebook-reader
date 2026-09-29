// API entrypoint (Hono). Modular boundaries grow per §18; M1 ships health,
// auth and the admin-guarded upload stub (the M1 gate: 非 Admin 無法上傳).
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, and, isNull, gt, asc, sql } from 'drizzle-orm';
import { makePool, makeDb, checkDatabase, closePool } from './db/client.ts';
import { users, sessions, works, sourceFiles, importJobs, importItems } from './db/schema.ts';
import { verifyPassword } from './auth/password.ts';
import { SESSION_COOKIE, tokenId, newSession, cookieOpts } from './auth/session.ts';
import { localStorage } from './storage.ts';
import { PROCESSOR_VERSION, MAX_ATTEMPTS } from './import/queue.ts';
import { commitImport } from './import/commit.ts';

const pool = makePool({
  connectionString: process.env.DATABASE_URL ?? '',
  max: 5,
  applicationName: 'ebook-api',
});
const db = makeDb(pool);

export const app = new Hono<{ Variables: { userId: string; role: string } }>();
app.use(logger());

// --- health / readiness --------------------------------------------------------
app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/readyz', async (c) => {
  try {
    await checkDatabase(pool);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'db unreachable' }, 503);
  }
});

// --- session resolution --------------------------------------------------------
app.use('/api/*', async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const rows = await db.select({ userId: sessions.userId, role: users.role, revokedAt: sessions.revokedAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, tokenId(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (rows[0]) {
      c.set('userId', rows[0].userId);
      c.set('role', rows[0].role);
    }
  }
  await next();
});

const requireAdmin = async (c: Context, next: Next) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
};

// middleware in the chain disables Hono's path-param inference; routes are
// always registered with ':id' so the cast is backed by the route itself
const routeId = (c: Context): string => c.req.param('id') as string;

// --- auth ----------------------------------------------------------------------
app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  if (typeof email !== 'string' || typeof password !== 'string') {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const rows = await db.select({ id: users.id, passwordHash: users.passwordHash })
    .from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  const user = rows[0];
  // uniform error: no account enumeration
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  const session = newSession();
  await db.insert(sessions).values({ id: session.id, userId: user.id, expiresAt: session.expiresAt });
  setCookie(c, SESSION_COOKIE, session.token, cookieOpts());
  return c.json({ ok: true });
});

app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, tokenId(token)));
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', (c) => {
  if (!c.get('userId')) return c.json({ user: null }, 401);
  return c.json({ user: { id: c.get('userId'), role: c.get('role') } });
});

// --- admin imports (M2) --------------------------------------------------------
// Conservative configurable upload bounds (dev-plan §20 starting quotas)
const MAX_TXT_BYTES = Number(process.env.IMPORT_MAX_TXT_BYTES ?? 30 * 1024 * 1024);
const MAX_EPUB_BYTES = Number(process.env.IMPORT_MAX_EPUB_BYTES ?? 50 * 1024 * 1024);
const storage = localStorage();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

app.use('/api/admin/imports/*', bodyLimit({ maxSize: MAX_EPUB_BYTES }));
app.use('/api/admin/imports', bodyLimit({ maxSize: MAX_EPUB_BYTES }));

// upload: bounded, admin-only; storage keys are server-generated (never from
// the client filename) and the raw bytes are never logged
app.post('/api/admin/imports', requireAdmin, async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!(file instanceof File)) return c.json({ error: 'file_required' }, 400);
  const field = (name: string): string | undefined => {
    const v = form?.[name];
    return typeof v === 'string' ? v : undefined;
  };

  const name = file.name ?? '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  if (ext !== '.txt' && ext !== '.epub') {
    return c.json({ error: 'unsupported_format', allowed: ['.txt', '.epub'] }, 415);
  }
  const maxBytes = ext === '.txt' ? MAX_TXT_BYTES : MAX_EPUB_BYTES;
  if (file.size > maxBytes) {
    return c.json({ error: 'file_too_large', max_bytes: maxBytes }, 413);
  }
  // trust the content type only to reject, never to accept something odd
  const type = file.type;
  if (type && !type.startsWith('text/') && !['application/epub+zip', 'application/octet-stream'].includes(type)) {
    return c.json({ error: 'unsupported_media_type', content_type: type }, 415);
  }

  let workId: string | null = null;
  const rawWorkId = field('workId');
  if (rawWorkId) {
    if (!UUID_RE.test(rawWorkId)) return c.json({ error: 'invalid_work_id' }, 400);
    const w = await db.select({ id: works.id }).from(works).where(eq(works.id, rawWorkId)).limit(1);
    if (w.length === 0) return c.json({ error: 'work_not_found' }, 404);
    workId = rawWorkId;
  }
  const rawEncoding = field('encoding');
  const requestedEncoding = rawEncoding ? rawEncoding.toLowerCase() : null;

  const buf = Buffer.from(await file.arrayBuffer());
  const mimeType = ext === '.epub' ? 'application/epub+zip' : 'text/plain';
  const storageKey = await storage.put(buf, ext.slice(1));
  const [src] = await db.insert(sourceFiles).values({
    workId,
    storageKey,
    fileHash: sha256(buf),
    sizeBytes: buf.length,
    mimeType,
  }).returning({ id: sourceFiles.id });

  // every upload is its own import job even for identical bytes — file-level
  // dedupe (via file_hash) is a later optimization, not job identity
  const [job] = await db.insert(importJobs).values({
    workId,
    sourceFileId: src.id,
    requestedByUserId: c.get('userId'),
    requestedEncoding,
    detectedFormat: ext === '.epub' ? 'epub' : 'txt',
    processorVersion: PROCESSOR_VERSION,
  }).returning({ id: importJobs.id });

  return c.json({ importId: job.id, sourceFileId: src.id }, 201);
});

app.get('/api/admin/imports/:id', requireAdmin, async (c) => {
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, routeId(c))).limit(1);
  if (!job) return c.json({ error: 'not_found' }, 404);
  const [file] = await db.select({
    fileHash: sourceFiles.fileHash,
    sizeBytes: sourceFiles.sizeBytes,
    mimeType: sourceFiles.mimeType,
    createdAt: sourceFiles.createdAt,
  }).from(sourceFiles).where(eq(sourceFiles.id, job.sourceFileId)).limit(1);
  const [counts] = await db.select({
    staged: sql<number>`count(*)::int`,
    needsReview: sql<number>`(count(*) filter (where ${importItems.needsReview}))::int`,
  }).from(importItems).where(eq(importItems.importJobId, job.id));
  return c.json({ ...job, sourceFile: file, stagedChapters: counts.staged, stagedNeedsReview: counts.needsReview, maxAttempts: MAX_ATTEMPTS });
});

app.get('/api/admin/imports/:id/chapters', requireAdmin, async (c) => {
  const id = routeId(c);
  const job = await db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.id, id)).limit(1);
  if (job.length === 0) return c.json({ error: 'not_found' }, 404);
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const [total] = await db.select({ n: sql<number>`count(*)::int` })
    .from(importItems).where(eq(importItems.importJobId, id));
  const items = await db.select({
    position: importItems.position,
    volumeLabel: importItems.volumeLabel,
    labelRaw: importItems.labelRaw,
    parsedLabel: importItems.parsedLabel,
    title: importItems.title,
    snippet: importItems.snippet,
    warnings: importItems.warnings,
    needsReview: importItems.needsReview,
  }).from(importItems)
    .where(eq(importItems.importJobId, id))
    .orderBy(asc(importItems.position))
    .limit(limit).offset((page - 1) * limit);
  return c.json({ total: total.n, page, limit, chapters: items });
});

app.post('/api/admin/imports/:id/commit', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await commitImport(db, routeId(c), {
    workId: typeof body.workId === 'string' ? body.workId : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    workType: typeof body.workType === 'string' ? body.workType : undefined,
  });
  if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
  return c.json({
    workId: result.workId,
    chapterCount: result.chapterCount,
    alreadyCommitted: result.alreadyCommitted,
  });
});

// re-run parsing, optionally with an explicit encoding override (encoding
// preview→review loop from dev-plan §07)
app.post('/api/admin/imports/:id/reanalyze', requireAdmin, async (c) => {
  const id = routeId(c);
  const body = await c.req.json().catch(() => ({}));
  const encoding = typeof body.encoding === 'string' && body.encoding ? body.encoding.toLowerCase() : null;
  const rows = await db.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
  const job = rows[0];
  if (!job) return c.json({ error: 'not_found' }, 404);
  if (job.status === 'committed' || job.status === 'processing' || job.status === 'queued') {
    return c.json({ error: 'invalid_state', detail: `job status is ${job.status}` }, 409);
  }
  if (job.attemptCount >= MAX_ATTEMPTS) {
    return c.json({ error: 'max_attempts_reached' }, 409);
  }
  await db.transaction(async (tx) => {
    await tx.delete(importItems).where(eq(importItems.importJobId, id));
    await tx.update(importJobs).set({
      status: 'queued',
      requestedEncoding: encoding ?? job.requestedEncoding,
      chapterCount: null,
      detectedEncoding: null,
      encodingResult: null,
      errorCode: null,
      errorDetail: null,
      completedAt: null,
    }).where(eq(importJobs.id, id));
  });
  return c.json({ ok: true });
});

// graceful shutdown: stop taking work, drain the pool (§16A-G).
// serve() only when run as the entrypoint — tests import `app` directly.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
let server: ReturnType<typeof serve> | null = null;
if (isMain) {
  server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => {
    console.log(`api listening on :${info.port}`);
  });
}
async function shutdown() {
  server?.close();
  await closePool(pool);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
