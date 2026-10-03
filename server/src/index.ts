// API entrypoint (Hono). Slim wiring: validated config → bounded pool →
// session middleware → route modules (§18 modular boundaries).
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { loadApiConfig } from './config.ts';
import { makePool, makeDb, closePool } from './db/client.ts';
import { users, sessions } from './db/schema.ts';
import { tokenId } from './auth/session.ts';
import { localStorage } from './storage.ts';
import { installErrorHandlers } from './http/errors.ts';
import { securityHeaders } from './http/security.ts';
import { healthRoutes } from './routes/health.ts';
import { authRoutes } from './routes/auth.ts';
import { requireAdmin } from './http/guards.ts';
import { adminImportRoutes } from './routes/admin-imports.ts';
import { adminWorkRoutes } from './routes/admin-works.ts';
import { readerRoutes } from './routes/reader.ts';
import { worksRoutes } from './routes/works.ts';
import { meRoutes } from './routes/me.ts';

export const apiConfig = loadApiConfig();
const config = apiConfig;

const pool = makePool({
  connectionString: config.databaseUrl,
  max: 5,
  applicationName: 'ebook-api',
  tlsMode: config.tlsMode,
  dbCaFile: config.dbCaFile,
});
const db = makeDb(pool);

export const app = new Hono<{ Variables: { userId: string; role: string } }>();
app.use(logger());
installErrorHandlers(app);
app.use('*', securityHeaders({ hsts: config.hsts }));

// Bound JSON bodies globally. The import upload routes raise their own limit
// (admin-imports.ts) and are matched first; everything else has no reason to
// accept more than a few hundred KiB, and without a cap a single request could
// make the process buffer arbitrary memory before any validation runs.
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/admin/imports')) return next();
  return bodyLimit({
    maxSize: config.maxJsonBytes,
    onError: (ctx) => ctx.json({ error: 'payload_too_large', maxBytes: config.maxJsonBytes }, 413),
  })(c, next);
});

// CSRF (§53): cookie auth is SameSite=Lax, but top-level cross-site form POSTs
// still carry cookies — so every state-changing /api request presenting an
// Origin header must come from our own origin. Browsers always send Origin on
// cross-origin POSTs; same-origin fetches send it too. Non-browser clients
// without Origin are unaffected (they don't carry our cookies).
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin) {
      let ok = false;
      try {
        const originHost = new URL(origin).host;
        ok = originHost === c.req.header('host') || config.csrfAllowedOrigins.includes(origin);
      } catch {
        ok = false;
      }
      if (!ok) return c.json({ error: 'origin_mismatch' }, 403);
    }
  }
  await next();
});

// resolve the session cookie (if any) for every /api route — registered
// BEFORE the route modules so guards see the resolved role
app.use('/api/*', async (c, next) => {
  const token = c.req.header('cookie')?.match(/(?:^|;\s*)ebook_session=([^;]+)/)?.[1]
    ?? null;
  if (token) {
    const rows = await db.select({ userId: sessions.userId, role: users.role })
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

// Admin guard mounted on the parent app, before any admin route module. It
// previously lived inside adminImportRoutes and only covered admin-works.ts
// because Hono hoists `/api/admin/*` middleware and that module happened to be
// mounted first — swapping two app.route() lines would have silently exposed
// publish and taxonomy. The guard now does not depend on mount order.
app.use('/api/admin/*', requireAdmin);

app.get('/api/me', (c) => {
  if (!c.get('userId')) return c.json({ user: null }, 401);
  return c.json({ user: { id: c.get('userId'), role: c.get('role') } });
});

app.route('/', healthRoutes(pool));
app.route('/', authRoutes({ db, config }));
app.route('/', meRoutes({ db }));
app.route('/', adminImportRoutes({ db, storage: localStorage(config.storageRoot), config }));
app.route('/', adminWorkRoutes({ db, storage: localStorage(config.storageRoot) }));
app.route('/', readerRoutes({ db, storage: localStorage(config.storageRoot) }));
app.route('/', worksRoutes({ db }));

// bind only when run as the entrypoint — test files import `app` without
// grabbing a port (and colliding with a running dev server)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`api listening on :${info.port}`);
  });
  const shutdown = async () => {
    server.close();
    await closePool(pool);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
