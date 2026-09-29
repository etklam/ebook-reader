// Auth routes: session-cookie login/logout/me. Uniform errors (no account
// enumeration); input caps bound work before any DB or hash work.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users, sessions } from '../db/schema.ts';
import { verifyPassword } from '../auth/password.ts';
import { SESSION_COOKIE, tokenId, newSession, cookieOpts } from '../auth/session.ts';

export function authRoutes(db: NodePgDatabase): Hono<{ Variables: { userId: string; role: string } }> {
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  app.post('/api/auth/login', async (c) => {
    const { email, password } = await c.req.json().catch(() => ({}));
    if (typeof email !== 'string' || typeof password !== 'string'
      || email.length === 0 || email.length > 320 || password.length === 0 || password.length > 1024) {
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

  return app;
}
