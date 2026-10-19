import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { authRoutes } from './auth.ts';
import { DUMMY_PASSWORD_HASH } from '../auth/password.ts';

test('unknown and existing accounts both perform exactly one password verification', async () => {
  for (const exists of [false, true]) {
    const hashes: string[] = [];
    const db = { select() {
      const chain = { from() { return chain; }, where() { return chain; }, async limit() {
        return exists ? [{ id: 'user', passwordHash: 'stored-hash' }] : [];
      } }; return chain;
    } } as unknown as NodePgDatabase;
    const app = authRoutes({ db, config: { registrationMode: 'closed', trustProxy: false,
      authRateLimit: { windowMs: 60000, maxPerIp: 60, maxPerAccount: 10 } },
      async verifyPassword(_password, hash) { hashes.push(hash); return false; },
    });
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'wrong' }) });
    assert.equal(res.status, 401); assert.deepEqual(await res.json(), { error: 'invalid_credentials' });
    assert.deepEqual(hashes, [exists ? 'stored-hash' : DUMMY_PASSWORD_HASH]);
  }
});
