// API entrypoint (Hono). Modular boundaries grow per §18; M1 ships health,
// auth and the admin-guarded upload stub (the M1 gate: 非 Admin 無法上傳).
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { makePool, makeDb, checkDatabase, closePool } from './db/client.ts';
import { users, sessions } from './db/schema.ts';
import { hashPassword, verifyPassword } from './auth/password.ts';
import { SESSION_COOKIE, tokenId, newSession, cookieOpts } from './auth/session.ts';

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

const requireAdmin = async (c: any, next: any) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
};

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

// --- admin (M1 stub: guard proven, upload lands in M2) -------------------------
app.post('/api/admin/imports', requireAdmin, (c) =>
  c.json({ error: 'not_implemented', phase: 'M2' }, 501));

// graceful shutdown: stop taking work, drain the pool (§16A-G)
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => {
  console.log(`api listening on :${info.port}`);
});
async function shutdown() {
  server.close();
  await closePool(pool);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
