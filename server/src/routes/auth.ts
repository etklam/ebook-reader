// Auth routes: session-cookie login/logout/me + controlled Beta registration
// (§25). Registration mode comes from validated config; invites are single-use
// and only the sha256 of a token is stored.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { registrationInvites, users, sessions } from '../db/schema.ts';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import { SESSION_COOKIE, tokenId, newSession, cookieOpts } from '../auth/session.ts';
import type { ApiConfig } from '../config.ts';
import { clientIp, createRateLimiter, rateLimit } from '../http/rate-limit.ts';

const USERNAME_RE = /^[\p{Script=Han}a-z0-9_-]{2,30}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthDeps {
  db: NodePgDatabase;
  config: Pick<ApiConfig, 'registrationMode' | 'authRateLimit' | 'trustProxy'>;
}

export function authRoutes(deps: AuthDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db, config } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  // Two independent buckets (M7): per-address caps one host hammering the
  // endpoint, per-account caps a distributed attack converging on one victim's
  // password. Either one tripping is a 429.
  const { windowMs, maxPerIp, maxPerAccount } = config.authRateLimit;
  const ipLimiter = createRateLimiter({ windowMs, max: maxPerIp });
  const accountLimiter = createRateLimiter({ windowMs, max: maxPerAccount });

  app.use('/api/auth/login', rateLimit({
    limiter: ipLimiter,
    keyOf: (c) => `login:${clientIp(c, config.trustProxy)}`,
    errorCode: 'too_many_attempts',
  }));
  app.use('/api/auth/register', rateLimit({
    limiter: ipLimiter,
    keyOf: (c) => `register:${clientIp(c, config.trustProxy)}`,
    errorCode: 'too_many_attempts',
  }));

  app.post('/api/auth/login', async (c) => {
    const { email, password } = await c.req.json().catch(() => ({}));
    if (typeof email !== 'string' || typeof password !== 'string'
      || email.length === 0 || email.length > 320 || password.length === 0 || password.length > 1024) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // Per-account check happens before the scrypt verify so a targeted attack
    // cannot spend our CPU; it is keyed on the submitted address whether or not
    // an account exists, so it leaks nothing about which addresses are real.
    const accountVerdict = accountLimiter.check(`login:${email.toLowerCase()}`);
    if (!accountVerdict.allowed) {
      c.header('Retry-After', String(accountVerdict.retryAfter));
      return c.json({ error: 'too_many_attempts', retryAfter: accountVerdict.retryAfter }, 429);
    }
    const rows = await db.select({ id: users.id, passwordHash: users.passwordHash })
      .from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    const user = rows[0];
    // uniform error: no account enumeration
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return c.json({ error: 'invalid_credentials' }, 401);
    }
    // credit the successful attempt: the limit exists to stop guessing, not to
    // punish someone who logs in from several devices
    accountLimiter.clear(`login:${email.toLowerCase()}`);
    const session = newSession();
    await db.insert(sessions).values({
      id: session.id,
      userId: user.id,
      expiresAt: session.expiresAt,
      // lets the member recognise this device in /api/me/sessions (M7)
      userAgent: (c.req.header('user-agent') ?? '').slice(0, 200),
    });
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

  // controlled Beta registration (§25/§26). closed → always refused; invite →
  // single-use hashed token; open → documented Beta-only shortcut, no email
  // verification exists yet so default stays closed.
  app.post('/api/auth/register', async (c) => {
    if (config.registrationMode === 'closed') return c.json({ error: 'registration_closed' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const invite = typeof body?.invite === 'string' ? body.invite.trim() : '';
    if (!USERNAME_RE.test(username) || !EMAIL_RE.test(email) || email.length > 320
      || password.length < 8 || password.length > 1024) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (config.registrationMode === 'invite' && !invite) {
      return c.json({ error: 'invite_required' }, 403);
    }

    // invite consumed in the same transaction as account creation: single use
    const result = await db.transaction(async (tx) => {
      if (config.registrationMode === 'invite') {
        const tokenHash = createHash('sha256').update(invite).digest('hex');
        const [inv] = await tx.select().from(registrationInvites)
          .where(and(eq(registrationInvites.tokenHash, tokenHash), isNull(registrationInvites.usedAt)))
          .for('update').limit(1);
        if (!inv || inv.expiresAt.getTime() < Date.now()) {
          return { error: inv ? 'invite_expired' : 'invite_invalid' } as const;
        }
        const [user] = await tx.insert(users).values({
          username,
          email,
          passwordHash: await hashPassword(password),
          role: 'member',
        }).returning({ id: users.id });
        await tx.update(registrationInvites)
          .set({ usedAt: new Date(), usedByUserId: user.id })
          .where(eq(registrationInvites.tokenHash, tokenHash));
        return { userId: user.id } as const;
      }
      const [user] = await tx.insert(users).values({
        username,
        email,
        passwordHash: await hashPassword(password),
        role: 'member',
      }).returning({ id: users.id });
      return { userId: user.id } as const;
    }).catch((e: { code?: string; cause?: { code?: string } }) => {
      const code = e.code ?? e.cause?.code;
      // unique violation on email or username — generic message reduces
      // account enumeration while still telling the client to retry
      if (code === '23505') return { error: 'invalid_request' } as const;
      throw e;
    });
    if ('error' in result) {
      return c.json({ error: result.error }, result.error === 'invalid_request' ? 400 : 403);
    }
    const session = newSession();
    await db.insert(sessions).values({
      id: session.id,
      userId: result.userId,
      expiresAt: session.expiresAt,
      userAgent: (c.req.header('user-agent') ?? '').slice(0, 200),
    });
    setCookie(c, SESSION_COOKIE, session.token, cookieOpts());
    return c.json({ ok: true }, 201);
  });

  // Admin: create single-use invite; raw token shown once, only hash stored
  app.post('/api/admin/invites', async (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'forbidden' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const days = Number.isFinite(body?.expiresInDays) ? Math.min(30, Math.max(1, body.expiresInDays)) : 7;
    const token = randomBytes(24).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db.insert(registrationInvites).values({
      tokenHash,
      createdByUserId: c.get('userId'),
      expiresAt: new Date(Date.now() + days * 24 * 3600 * 1000),
    });
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(registrationInvites);
    return c.json({ invite: token, expiresInDays: days, totalIssued: n.n }, 201);
  });

  return app;
}
