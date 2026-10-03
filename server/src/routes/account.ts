// Account self-service (M7 Phase 3.2). Before this, auth was login/logout/
// register only: a member could not change their password, could not see or
// revoke their sessions, and had no recovery path at all — so a leaked session
// cookie stayed valid for its full 30-day TTL with nothing anyone could do.
//
// Recovery without an email service: an Admin issues a one-time reset token
// out-of-band and the member redeems it, the same shape as registration
// invites (only the sha256 stored, single use, expiring). This makes recovery
// possible in Beta; it is NOT a substitute for email verification, so
// REGISTRATION_MODE=open stays unsupported (see docs/beta-runbook.md).
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { passwordResets, sessions, users } from '../db/schema.ts';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import { SESSION_COOKIE, cookieOpts, newSession, tokenId } from '../auth/session.ts';
import { clientIp, createRateLimiter, rateLimit } from '../http/rate-limit.ts';
import type { ApiConfig } from '../config.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;

export interface AccountDeps {
  db: NodePgDatabase;
  config: Pick<ApiConfig, 'authRateLimit' | 'trustProxy'>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function accountRoutes(deps: AccountDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db, config } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  // Redeeming a reset token is a guessing target, and the password-change route
  // runs scrypt twice (verify + hash). Both are throttled per address for the
  // same reasons as login (http/rate-limit.ts).
  const { windowMs, maxPerIp } = config.authRateLimit;
  const limiter = createRateLimiter({ windowMs, max: maxPerIp });
  for (const path of ['/api/auth/password-reset', '/api/me/password'] as const) {
    app.use(path, rateLimit({
      limiter,
      keyOf: (c) => `reset:${clientIp(c, config.trustProxy)}`,
      errorCode: 'too_many_attempts',
    }));
  }

  const requireUser = async (c: { get: (k: 'userId') => string; json: (b: unknown, s?: 200 | 401) => Response },
    next: () => Promise<void>) => {
    if (!c.get('userId')) return c.json({ error: 'forbidden' }, 401);
    await next();
  };

  // --- password change --------------------------------------------------------
  // Changing a password revokes every OTHER session: if the reason for changing
  // it is that someone else has your cookie, leaving their session alive makes
  // the change pointless. The current device keeps a freshly issued session so
  // the member is not logged out of the page they are standing on.
  app.post('/api/me/password', requireUser, async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({}));
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
    if (newPassword.length < MIN_PASSWORD || newPassword.length > MAX_PASSWORD
      || currentPassword.length === 0 || currentPassword.length > MAX_PASSWORD) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (newPassword === currentPassword) {
      return c.json({ error: 'password_unchanged' }, 400);
    }
    const [user] = await db.select({ passwordHash: users.passwordHash })
      .from(users).where(eq(users.id, userId)).limit(1);
    // re-authentication: possessing the cookie is not enough to change the
    // credential the cookie was derived from
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      return c.json({ error: 'invalid_credentials' }, 401);
    }

    const replacement = newSession();
    const hash = await hashPassword(newPassword);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: hash }).where(eq(users.id, userId));
      await tx.update(sessions).set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await tx.insert(sessions).values({
        id: replacement.id,
        userId,
        expiresAt: replacement.expiresAt,
        userAgent: (c.req.header('user-agent') ?? '').slice(0, 200),
      });
      // any outstanding reset token is void once the password is set
      await tx.update(passwordResets).set({ usedAt: new Date() })
        .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
    });
    setCookie(c, SESSION_COOKIE, replacement.token, cookieOpts());
    return c.json({ ok: true, otherSessionsRevoked: true });
  });

  // --- session list / revocation ----------------------------------------------
  app.get('/api/me/sessions', requireUser, async (c) => {
    const userId = c.get('userId');
    const token = getCookie(c, SESSION_COOKIE);
    const currentId = token ? tokenId(token) : null;
    const rows = await db.select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
    }).from(sessions)
      .where(and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
      ))
      .orderBy(desc(sessions.lastSeenAt))
      .limit(100);
    return c.json({
      sessions: rows.map((r) => ({
        // the row id is the sha256 of a live token; exposing it would hand the
        // client a value that identifies a session it may not own. A short
        // opaque handle is enough to target one for revocation.
        id: r.id.slice(0, 16),
        current: r.id === currentId,
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      })),
    });
  });

  // "log out other devices" — keeps the caller signed in
  app.delete('/api/me/sessions', requireUser, async (c) => {
    const userId = c.get('userId');
    const token = getCookie(c, SESSION_COOKIE);
    const currentId = token ? tokenId(token) : null;
    const revoked = await db.update(sessions).set({ revokedAt: new Date() })
      .where(and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        currentId ? ne(sessions.id, currentId) : sql`true`,
      ))
      .returning({ id: sessions.id });
    return c.json({ ok: true, revoked: revoked.length });
  });

  // revoke one session by its short handle
  app.delete('/api/me/sessions/:handle', requireUser, async (c) => {
    const userId = c.get('userId');
    const handle = c.req.param('handle');
    if (!/^[0-9a-f]{16}$/.test(handle)) return c.json({ error: 'session_not_found' }, 404);
    const revoked = await db.update(sessions).set({ revokedAt: new Date() })
      .where(and(
        eq(sessions.userId, userId),            // ownership, never from the body
        isNull(sessions.revokedAt),
        sql`left(${sessions.id}, 16) = ${handle}`,
      ))
      .returning({ id: sessions.id });
    if (revoked.length === 0) return c.json({ error: 'session_not_found' }, 404);
    return c.json({ ok: true, revoked: revoked.length });
  });

  // --- Admin-issued recovery token ---------------------------------------------
  app.post('/api/admin/users/:userId/password-reset', async (c) => {
    const targetId = c.req.param('userId');
    if (!UUID_RE.test(targetId)) return c.json({ error: 'user_not_found' }, 404);
    const [target] = await db.select({ id: users.id, email: users.email })
      .from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) return c.json({ error: 'user_not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const hours = Number.isInteger(body?.expiresInHours)
      ? Math.min(168, Math.max(1, body.expiresInHours as number))
      : 24;
    const token = randomBytes(24).toString('base64url');
    await db.transaction(async (tx) => {
      // only one live token per user: issuing a new one invalidates the last,
      // so a stale token handed out earlier cannot still be redeemed
      await tx.update(passwordResets).set({ usedAt: new Date() })
        .where(and(eq(passwordResets.userId, targetId), isNull(passwordResets.usedAt)));
      await tx.insert(passwordResets).values({
        tokenHash: sha256(token),
        userId: targetId,
        createdByUserId: c.get('userId'),
        expiresAt: new Date(Date.now() + hours * 3600 * 1000),
      });
    });
    // shown once; only the hash is stored
    return c.json({ token, email: target.email, expiresInHours: hours }, 201);
  });

  // --- redeem a recovery token --------------------------------------------------
  // Unauthenticated by necessity: the member cannot sign in. Consuming the
  // token, setting the password and revoking every session happen in one
  // transaction so a token can never be spent without taking effect.
  app.post('/api/auth/password-reset', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
    if (!token || newPassword.length < MIN_PASSWORD || newPassword.length > MAX_PASSWORD) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const hash = await hashPassword(newPassword);
    const result = await db.transaction(async (tx) => {
      const [reset] = await tx.select().from(passwordResets)
        .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt)))
        .for('update').limit(1);
      if (!reset) return { error: 'reset_invalid' } as const;
      if (reset.expiresAt.getTime() < Date.now()) return { error: 'reset_expired' } as const;
      await tx.update(users).set({ passwordHash: hash }).where(eq(users.id, reset.userId));
      // recovery implies the old credential is not trusted: drop every session
      await tx.update(sessions).set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, reset.userId), isNull(sessions.revokedAt)));
      await tx.update(passwordResets).set({ usedAt: new Date() })
        .where(eq(passwordResets.tokenHash, reset.tokenHash));
      return { userId: reset.userId } as const;
    });
    if ('error' in result) {
      return c.json({ error: result.error }, result.error === 'reset_expired' ? 410 : 400);
    }
    // deliberately does NOT sign the user in: they prove the new password works
    // by logging in with it, and a redeemed token never becomes a session
    return c.json({ ok: true });
  });

  return app;
}
