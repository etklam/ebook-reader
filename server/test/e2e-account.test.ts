// L2 E2E acceptance (M7 Phase 3.2/3.3): account self-service and reclamation.
//
//   ACC-01  password change requires the current password
//   ACC-02  changing a password revokes other sessions but keeps this device
//   ACC-03  session list / revoke one / revoke others
//   ACC-04  Admin-issued reset token: single use, expiring, Admin-only
//   ACC-05  redeeming a reset revokes every session and does not sign anyone in
//   ACC-06  session and reset sweeps delete only unusable rows
//
// Run: pnpm --filter server test:e2e   (needs `pnpm db:up` + `pnpm db:migrate`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';

process.env.STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'ebook-e2e-acc-'));
const { app } = await import('../src/index.ts');
const { hashPassword } = await import('../src/auth/password.ts');
const { makeDb } = await import('../src/db/client.ts');
const { sweepSessions, sweepPasswordResets } = await import('../src/maintenance/reclaim.ts');

const SUFFIX = Math.random().toString(36).slice(2, 8);
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL ?? '', max: 2 });
const db = makeDb(pool);
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

const email = (role: string) => `e2e-acc-${role}-${SUFFIX}@example.test`;
const PW = 'pw-12345678';
let adminCookie = '';
let memberId = '';

async function login(addr: string, password: string, userAgent = 'test-agent'): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify({ email: addr, password }),
  });
  assert.equal(res.status, 200, `login ${addr} → ${res.status}`);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

const POST = (path: string, cookie: string, body: unknown) => app.request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const DEL = (path: string, cookie: string) =>
  app.request(path, { method: 'DELETE', headers: { cookie } });
const GET = (path: string, cookie: string) => app.request(path, { headers: { cookie } });

const whoami = async (cookie: string) => (await GET('/api/me', cookie)).status;

before(async () => {
  for (const role of ['admin', 'member'] as const) {
    const [row] = await q(
      `insert into app.users (username, email, password_hash, role)
       values ($1, $2, $3, $4) returning id`,
      [`e2e-acc-${role}-${SUFFIX}`, email(role), await hashPassword(PW), role]);
    if (role === 'member') memberId = row.id;
  }
  adminCookie = await login(email('admin'), PW);
});

after(async () => {
  await q(`delete from app.password_resets where user_id in
           (select id from app.users where email like $1)`, [`e2e-acc-%-${SUFFIX}@example.test`]);
  await q(`delete from app.sessions where user_id in
           (select id from app.users where email like $1)`, [`e2e-acc-%-${SUFFIX}@example.test`]);
  await q(`delete from app.users where email like $1`, [`e2e-acc-%-${SUFFIX}@example.test`]);
  await pool.end();
  rmSync(process.env.STORAGE_ROOT!, { recursive: true, force: true });
});

test('ACC-01: password change needs the current password and a different new one', async () => {
  const cookie = await login(email('member'), PW);

  assert.equal((await POST('/api/me/password', '', { currentPassword: PW, newPassword: 'whatever-1' })).status, 401,
    'anonymous callers cannot change a password');

  const wrong = await POST('/api/me/password', cookie, {
    currentPassword: 'not-my-password', newPassword: 'brand-new-123',
  });
  assert.equal(wrong.status, 401, 'holding the cookie is not enough to change the credential');
  assert.equal(((await wrong.json()) as { error: string }).error, 'invalid_credentials');

  const same = await POST('/api/me/password', cookie, { currentPassword: PW, newPassword: PW });
  assert.equal(same.status, 400);
  assert.equal(((await same.json()) as { error: string }).error, 'password_unchanged');

  const short = await POST('/api/me/password', cookie, { currentPassword: PW, newPassword: 'short' });
  assert.equal(short.status, 400);

  // the password is untouched after every refusal
  await login(email('member'), PW);
});

test('ACC-02: changing a password revokes other sessions, keeps the current device', async () => {
  // reset to a known password for this test
  await q(`update app.users set password_hash = $2 where id = $1`, [memberId, await hashPassword(PW)]);
  const deviceA = await login(email('member'), PW, 'device-A');
  const deviceB = await login(email('member'), PW, 'device-B');
  assert.equal(await whoami(deviceA), 200);
  assert.equal(await whoami(deviceB), 200);

  const NEW = 'changed-password-1';
  const res = await POST('/api/me/password', deviceA, { currentPassword: PW, newPassword: NEW });
  assert.equal(res.status, 200);
  const body = await res.json() as { otherSessionsRevoked: boolean };
  assert.equal(body.otherSessionsRevoked, true);

  // device A is handed a fresh cookie in the response and stays signed in
  const rotated = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  assert.ok(rotated.includes('ebook_session='), 'a replacement session cookie is issued');
  assert.equal(await whoami(rotated), 200, 'the device that changed the password stays signed in');

  // the old cookie on that same device, and device B, are both dead: if the
  // reason for the change is a stolen cookie, leaving it alive is pointless
  assert.equal(await whoami(deviceA), 401, 'the pre-change cookie no longer authenticates');
  assert.equal(await whoami(deviceB), 401, 'other devices are signed out');

  // the new password works, the old one does not
  assert.equal((await POST('/api/auth/login', '', { email: email('member'), password: PW })).status, 401);
  await login(email('member'), NEW);
  await q(`update app.users set password_hash = $2 where id = $1`, [memberId, await hashPassword(PW)]);
});

test('ACC-03: session list, revoke one, revoke others', async () => {
  await q(`update app.sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [memberId]);
  const a = await login(email('member'), PW, 'phone-safari');
  const b = await login(email('member'), PW, 'laptop-chrome');
  const c = await login(email('member'), PW, 'tablet');

  const listed = await (await GET('/api/me/sessions', a)).json() as {
    sessions: Array<{ id: string; current: boolean; userAgent: string }>;
  };
  assert.equal(listed.sessions.length, 3);
  assert.equal(listed.sessions.filter((s) => s.current).length, 1, 'exactly one session is the caller');
  assert.ok(listed.sessions.some((s) => s.userAgent === 'phone-safari'));
  // the stored id is the sha256 of a live token; only a short handle is exposed
  for (const s of listed.sessions) assert.match(s.id, /^[0-9a-f]{16}$/);

  // revoke a specific other session
  const target = listed.sessions.find((s) => s.userAgent === 'tablet')!;
  assert.equal((await DEL(`/api/me/sessions/${target.id}`, a)).status, 200);
  assert.equal(await whoami(c), 401, 'the revoked device is signed out');
  assert.equal(await whoami(b), 200, 'untargeted sessions are unaffected');
  assert.equal(await whoami(a), 200);

  assert.equal((await DEL(`/api/me/sessions/${target.id}`, a)).status, 404, 'revoking twice is a 404');
  assert.equal((await DEL('/api/me/sessions/not-a-handle', a)).status, 404);

  // another member cannot revoke this member's session
  const otherCookie = adminCookie;
  assert.equal((await DEL(`/api/me/sessions/${listed.sessions.find((s) => s.userAgent === 'laptop-chrome')!.id}`,
    otherCookie)).status, 404, 'ownership comes from the session, never the path');
  assert.equal(await whoami(b), 200, 'and the victim session is still alive');

  // log out other devices
  const bulk = await (await DEL('/api/me/sessions', a)).json() as { revoked: number };
  assert.equal(bulk.revoked, 1, 'only the remaining other session is revoked');
  assert.equal(await whoami(b), 401);
  assert.equal(await whoami(a), 200, 'the caller keeps their own session');
});

test('ACC-04: reset tokens are Admin-only, single-use and expiring', async () => {
  const memberCookie = await login(email('member'), PW);
  assert.equal((await POST(`/api/admin/users/${memberId}/password-reset`, memberCookie, {})).status, 403,
    'a member cannot issue themselves a reset');
  assert.equal((await POST(`/api/admin/users/${memberId}/password-reset`, '', {})).status, 403);
  assert.equal((await POST('/api/admin/users/not-a-uuid/password-reset', adminCookie, {})).status, 404);
  assert.equal((await POST(
    `/api/admin/users/00000000-0000-0000-0000-000000000000/password-reset`, adminCookie, {})).status, 404);

  const issued = await POST(`/api/admin/users/${memberId}/password-reset`, adminCookie, { expiresInHours: 2 });
  assert.equal(issued.status, 201);
  const { token } = await issued.json() as { token: string };
  assert.ok(token && token.length > 20);

  // only the hash is stored — the raw token must not be recoverable from the DB
  const stored = await q(`select token_hash from app.password_resets where user_id = $1 and used_at is null`, [memberId]);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, token);

  // issuing a second token invalidates the first: a token handed out earlier
  // must not still be redeemable
  const second = await POST(`/api/admin/users/${memberId}/password-reset`, adminCookie, {});
  assert.equal(second.status, 201);
  const stale = await POST('/api/auth/password-reset', '', { token, newPassword: 'from-stale-token-1' });
  assert.equal(stale.status, 400);
  assert.equal(((await stale.json()) as { error: string }).error, 'reset_invalid');

  // an expired token is refused with a distinguishable status
  const { token: fresh } = await second.json() as { token: string };
  await q(`update app.password_resets set expires_at = now() - interval '1 hour'
           where user_id = $1 and used_at is null`, [memberId]);
  const expired = await POST('/api/auth/password-reset', '', { token: fresh, newPassword: 'too-late-123' });
  assert.equal(expired.status, 410);
  assert.equal(((await expired.json()) as { error: string }).error, 'reset_expired');

  // the password never changed through any of the refusals
  await login(email('member'), PW);
});

test('ACC-05: redeeming a reset revokes every session and does not sign anyone in', async () => {
  const before = await login(email('member'), PW, 'pre-reset-device');
  assert.equal(await whoami(before), 200);

  const issued = await POST(`/api/admin/users/${memberId}/password-reset`, adminCookie, {});
  const { token } = await issued.json() as { token: string };

  const RECOVERED = 'recovered-password-1';
  const res = await POST('/api/auth/password-reset', '', { token, newPassword: RECOVERED });
  assert.equal(res.status, 200);
  // a redeemed token must not become a session: recovery proves control of the
  // token, not of the account
  assert.deepEqual((res.headers.getSetCookie?.() ?? []), []);

  assert.equal(await whoami(before), 401, 'recovery distrusts the old credential entirely');
  assert.equal((await POST('/api/auth/login', '', { email: email('member'), password: PW })).status, 401);
  await login(email('member'), RECOVERED);

  // the token cannot be replayed
  const replay = await POST('/api/auth/password-reset', '', { token, newPassword: 'replayed-123' });
  assert.equal(replay.status, 400);

  await q(`update app.users set password_hash = $2 where id = $1`, [memberId, await hashPassword(PW)]);
});

test('ACC-06: sweeps delete only rows that can never be used again', async () => {
  const live = await login(email('member'), PW, 'keep-me');

  // one long-expired, one long-revoked, both past the grace period
  await q(`insert into app.sessions (id, user_id, expires_at, created_at)
           values ($1, $2, now() - interval '400 days', now() - interval '400 days')`,
    [`sweep-expired-${SUFFIX}`, memberId]);
  await q(`insert into app.sessions (id, user_id, expires_at, revoked_at, created_at)
           values ($1, $2, now() + interval '1 day', now() - interval '400 days', now() - interval '400 days')`,
    [`sweep-revoked-${SUFFIX}`, memberId]);
  // and one recently revoked, which must survive for support questions
  await q(`insert into app.sessions (id, user_id, expires_at, revoked_at, created_at)
           values ($1, $2, now() + interval '1 day', now(), now())`,
    [`sweep-recent-${SUFFIX}`, memberId]);

  const r = await sweepSessions(db, { graceDays: 30 });
  assert.ok(r.deleted >= 2, `expected at least the two stale rows, got ${r.deleted}`);

  const remaining = await q(`select id from app.sessions where id = any($1)`,
    [[`sweep-expired-${SUFFIX}`, `sweep-revoked-${SUFFIX}`, `sweep-recent-${SUFFIX}`]]);
  const ids = remaining.map((x: { id: string }) => x.id);
  assert.ok(!ids.includes(`sweep-expired-${SUFFIX}`), 'long-expired row removed');
  assert.ok(!ids.includes(`sweep-revoked-${SUFFIX}`), 'long-revoked row removed');
  assert.ok(ids.includes(`sweep-recent-${SUFFIX}`), 'recently revoked row kept inside the grace period');

  // the live session is untouched and still authenticates
  assert.equal(await whoami(live), 200, 'a sweep must never log a live member out');

  // spent reset tokens are collected, unspent ones are not
  const issued = await POST(`/api/admin/users/${memberId}/password-reset`, adminCookie, {});
  assert.equal(issued.status, 201);
  await q(`update app.password_resets set used_at = now() - interval '400 days'
           where user_id = $1`, [memberId]);
  const live2 = await POST(`/api/admin/users/${memberId}/password-reset`, adminCookie, {});
  assert.equal(live2.status, 201);

  const rr = await sweepPasswordResets(db, { graceDays: 30 });
  assert.ok(rr.deleted >= 1);
  const left = await q(`select used_at from app.password_resets where user_id = $1`, [memberId]);
  assert.equal(left.length, 1, 'the unspent token survives');
  assert.equal(left[0].used_at, null);
});
