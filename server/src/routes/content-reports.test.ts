import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import type { Storage } from '../storage.ts';
import { contentReportRoutes } from './content-reports.ts';

const id = '12345678-1234-1234-1234-123456789abc';
const payload = { workId: id, chapterId: id, revisionId: id, paragraphIndex: 1, message: '應為「你好」' };

function setup(role = 'member', reachable = true, missingStorage = false) {
  const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
  let storageReads = 0;
  const db = { execute: async (query: SQL) => {
    const compiled = new PgDialect().sqlToQuery(query);
    queries.push(compiled);
    return { rows: compiled.sql.includes('select cr.content_key')
      ? reachable ? [{ content_key: 'private-key' }] : [] : [{ id }] };
  } } as unknown as NodePgDatabase;
  const storage = { get: async () => {
    storageReads++;
    if (missingStorage) throw new Error('missing');
    return Buffer.from('第一段\n\n第二段');
  } } as unknown as Storage;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();
  app.use('*', async (c, next) => {
    if (role !== 'guest') c.set('userId', id);
    c.set('role', role); await next();
  });
  app.route('/', contentReportRoutes({ db, storage }));
  const submit = (body: unknown = payload) => app.request('/api/me/content-reports', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { app, submit, queries, storageReads: () => storageReads };
}

test('content reports require membership and admin routes reject members', async () => {
  const guest = setup('guest');
  assert.equal((await guest.submit()).status, 401);
  assert.equal(guest.queries.length, 0);
  const member = setup();
  assert.equal((await member.app.request('/api/admin/content-reports')).status, 403);
  assert.equal((await member.app.request(`/api/admin/content-reports/${id}`, { method: 'PATCH' })).status, 403);
  assert.equal(member.queries.length, 0);
});

test('content reports reject malformed locations and messages before querying', async () => {
  const { submit, queries } = setup();
  for (const patch of [{ workId: 'bad' }, { paragraphIndex: -1 }, { paragraphIndex: 0.5 },
    { message: '  ' }, { message: 'x'.repeat(1001) }, { revisionId: null }]) {
    assert.equal((await submit({ ...payload, ...patch })).status, 400);
  }
  assert.equal(queries.length, 0);
});

test('content reports only accept reachable active release paragraphs', async () => {
  const hidden = setup('member', false);
  assert.equal((await hidden.submit()).status, 404);
  assert.equal(hidden.storageReads(), 0);
  assert.ok(hidden.queries[0].sql.includes('ri.release_id = w.active_release_id'));
  assert.ok(hidden.queries[0].sql.includes("w.visibility in ('public', 'unlisted')"));
  assert.deepEqual(hidden.queries[0].params, [id, id, id]);
  const invalid = setup();
  assert.equal((await invalid.submit({ ...payload, paragraphIndex: 2 })).status, 400);
  assert.equal(invalid.queries.length, 1);
  const missing = setup('member', true, true);
  assert.equal((await missing.submit()).status, 409);
});

test('content reports store server paragraph excerpt and enforce submission limit', async () => {
  const { submit, queries } = setup();
  assert.equal((await submit({ ...payload, excerpt: '偽造段落' })).status, 201);
  assert.deepEqual(queries[1].params, [id, id, id, id, 1, '第二段', payload.message]);
  for (let n = 1; n < 20; n++) assert.equal((await submit()).status, 201);
  const limited = await submit();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
});

test('admin report filters validate input and resolving reports is explicit', async () => {
  const { app, queries } = setup('admin');
  assert.equal((await app.request('/api/admin/content-reports?status=all')).status, 400);
  assert.equal((await app.request('/api/admin/content-reports?offset=-1')).status, 400);
  assert.equal(queries.length, 0);
  const response = await app.request('/api/admin/content-reports?status=resolved&offset=50');
  assert.equal(response.status, 200);
  assert.deepEqual(queries[0].params, ['resolved', 50]);
  const patch = (status: string) => app.request(`/api/admin/content-reports/${id}`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
  assert.equal((await patch('open')).status, 400);
  assert.equal((await patch('resolved')).status, 200);
  assert.ok(queries[1].sql.includes('coalesce(resolved_at, now())'));
});
