import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import { meRoutes, parseLibraryMetadata } from './me.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const WORK = '22222222-2222-4222-8222-222222222222';
function setup(rows: unknown[] = [], updateRows: unknown[] = [{ workId: WORK }]) {
  const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
  const updates: unknown[] = [];
  const conflicts: Record<string, unknown>[] = [];
  const builder = (result: unknown[]) => {
    const chain = {
      from: () => chain, innerJoin: () => chain, leftJoin: () => chain,
      where: (query: SQL) => { queries.push(new PgDialect().sqlToQuery(query)); return chain; },
      orderBy: () => chain, limit: async () => result,
      returning: async () => result,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  };
  const db = {
    select: () => builder(rows), selectDistinct: () => builder([{ name: '歷史' }]),
    update: () => ({ set: (value: unknown) => { updates.push(value); return builder(updateRows); } }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async (value: { set: Record<string, unknown> }) => { conflicts.push(value.set); } }) }),
  } as unknown as NodePgDatabase;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();
  app.use('*', async (c, next) => { c.set('userId', USER); c.set('role', 'member'); await next(); });
  app.route('/', meRoutes({ db }));
  return { app, queries, updates, conflicts };
}
const patch = (app: ReturnType<typeof setup>['app'], body: unknown) => app.request(`/api/me/library/${WORK}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('library metadata accepts partial updates and normalizes empty groups', () => {
  assert.deepEqual(parseLibraryMetadata({ groupName: '  歷史  ' }), { groupName: '歷史' });
  assert.deepEqual(parseLibraryMetadata({ readingStatus: 'finished', groupName: ' ' }), { readingStatus: 'finished', groupName: null });
  for (const body of [null, [], {}, { userId: USER }, { readingStatus: 'toString' }, { groupName: 1 }, { groupName: 'a'.repeat(41) }]) {
    assert.equal(parseLibraryMetadata(body), null);
  }
});

test('library PATCH scopes updates to the session owner and returns 404 for an absent row', async () => {
  const { app, queries, updates } = setup();
  assert.equal((await patch(app, { readingStatus: 'paused' })).status, 200);
  assert.deepEqual(queries[0].params, [USER, WORK]);
  assert.ok(queries[0].sql.includes('"user_id"'));
  assert.ok(queries[0].sql.includes('"work_id"'));
  assert.equal((updates[0] as { readingStatus: string }).readingStatus, 'paused');
  const other = setup([], []);
  assert.equal((await patch(other.app, { groupName: null })).status, 404);
  assert.equal((await patch(app, { groupName: 'a'.repeat(41) })).status, 400);
  assert.equal(updates.length, 1);
});

test('saving an existing favorite preserves its group and reading status', async () => {
  const { app, conflicts } = setup([{ id: WORK, visibility: 'public' }]);
  assert.equal((await app.request(`/api/me/library/${WORK}`, { method: 'PUT' })).status, 200);
  assert.deepEqual(Object.keys(conflicts[0]), ['updatedAt']);
});

test('library metadata routes require a session and reject malformed work ids', async () => {
  const { app } = setup();
  assert.equal((await app.request('/api/me/library/invalid', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"readingStatus":"reading"}',
  })).status, 404);
  const unauthenticated = meRoutes({ db: {} as NodePgDatabase });
  assert.equal((await unauthenticated.request(`/api/me/library/${WORK}`, { method: 'PATCH' })).status, 401);
});

test('library filters include the whole shelf and bind the cursor to group and status', async () => {
  const row = {
    workId: WORK, sortValue: '2026-10-13T00:00:00.000000Z', title: '作品', author: '作者',
    readingStatus: 'reading', groupName: '歷史', addedAt: new Date(), updatedAt: new Date(),
    progressUpdatedAt: null, lastSeenVersion: null, latestVersion: null, newChapters: 0,
  };
  const { app, queries } = setup([row, { ...row, workId: USER }]);
  const response = await app.request('/api/me/library?limit=1&readingStatus=reading&groupName=歷史');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.groups, ['歷史']);
  assert.equal(body.works.length, 1);
  assert.equal(body.works[0].readingStatus, 'reading');
  assert.equal(body.works[0].groupName, '歷史');
  assert.deepEqual(queries[0].params, [USER, 'reading', '歷史']);
  assert.deepEqual(queries[1].params, [USER]);
  assert.equal((await app.request(`/api/me/library?cursor=${encodeURIComponent(body.nextCursor)}&readingStatus=reading&groupName=歷史`)).status, 200);
  assert.ok(queries[2].params.includes(row.sortValue));
  assert.equal((await app.request(`/api/me/library?cursor=${encodeURIComponent(body.nextCursor)}&readingStatus=finished&groupName=歷史`)).status, 400);
  const ungrouped = setup();
  assert.equal((await ungrouped.app.request('/api/me/library?groupName=')).status, 200);
  assert.ok(ungrouped.queries[0].sql.includes('"group_name" is null'));
  assert.equal((await app.request('/api/me/library?readingStatus=invalid')).status, 400);
});
