import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import type { Storage } from '../storage.ts';
import { requireAdmin } from '../http/guards.ts';
import { adminWorkRoutes } from './admin-works.ts';
import { adminChapterRoutes } from './admin-chapters.ts';
import { classify } from '../publish/publish.ts';

const WORK = '11111111-1111-4111-8111-111111111111';
const CHAPTER = '22222222-2222-4222-8222-222222222222';
const REVISION = '33333333-3333-4333-8333-333333333333';

function setup(results: unknown[][] = [], role = 'admin', updateResult = [{ id: WORK }]) {
  const predicates: ReturnType<PgDialect['sqlToQuery']>[] = [];
  const updates: Record<string, unknown>[] = [];
  const locks: string[] = [];
  const chain = (rows: unknown[]) => {
    const query = {
      from: () => query, orderBy: () => query,
      where: (condition: SQL) => { predicates.push(new PgDialect().sqlToQuery(condition)); return query; },
      for: (kind: string) => { locks.push(kind); return query; },
      limit: async () => rows, returning: async () => rows,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
  const database = {
    select: () => chain(results.shift() ?? []),
    update: () => ({ set: (values: Record<string, unknown>) => { updates.push(values); return chain(updateResult); } }),
    transaction: async (run: (tx: unknown) => unknown) => run(database),
  };
  const db = database as unknown as NodePgDatabase;
  const storage = {} as Storage;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();
  app.use('*', async (c, next) => { c.set('role', role); await next(); });
  app.use('/api/admin/*', requireAdmin);
  app.route('/', adminWorkRoutes({ db, storage }));
  app.route('/', adminChapterRoutes({ db, storage }));
  return { app, predicates, updates, locks };
}
const removeChapter = (app: ReturnType<typeof setup>['app'], expectedRevisionId = REVISION) =>
  app.request(`/api/admin/chapter-editor/works/${WORK}/chapters/${CHAPTER}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevisionId }),
  });

test('work removal retains content, increments edit version and hides removed works from admin search', async () => {
  const { app, updates, predicates } = setup();
  assert.equal((await app.request(`/api/admin/works/${WORK}`, { method: 'DELETE' })).status, 200);
  assert.equal(updates[0].visibility, 'removed');
  assert.ok(updates[0].updatedAt instanceof Date);
  assert.ok(new PgDialect().sqlToQuery(updates[0].editVersion as SQL).sql.includes(' + 1'));
  assert.deepEqual(predicates[0].params, [WORK]);
  assert.equal((await app.request('/api/admin/works?q=novel')).status, 200);
  assert.match(predicates[1].sql, /visibility.*<> 'removed'/);
  const missing = setup([], 'admin', []);
  assert.equal((await missing.app.request(`/api/admin/works/${WORK}`, { method: 'DELETE' })).status, 404);
});

test('chapter removal locks work and chapter, checks revision and preserves historical rows', async () => {
  const { app, updates, locks, predicates } = setup([[{ id: WORK }], [{ headRevisionId: REVISION }], [{ n: 2 }]]);
  assert.equal((await removeChapter(app)).status, 200);
  assert.deepEqual(locks, ['update', 'update']);
  assert.deepEqual(Object.keys(updates[0]), ['deletedAt']);
  assert.ok(updates[0].deletedAt instanceof Date);
  assert.match(predicates[1].sql, /deleted_at.*is null/);
  assert.deepEqual(predicates[1].params, [CHAPTER, WORK]);
  assert.ok(updates[1].editVersion);
});

test('chapter removal rejects stale revisions, missing chapters, last chapters and invalid input without writes', async () => {
  for (const [rows, expectedStatus] of [
    [[[{ id: WORK }], [{ headRevisionId: WORK }]], 409],
    [[[{ id: WORK }], []], 404],
    [[[{ id: WORK }], [{ headRevisionId: REVISION }], [{ n: 1 }]], 409],
  ] as const) {
    const { app, updates } = setup(rows.map((row) => [...row]));
    assert.equal((await removeChapter(app)).status, expectedStatus);
    assert.deepEqual(updates, []);
  }
  const { app, updates } = setup();
  assert.equal((await removeChapter(app, 'invalid')).status, 400);
  assert.equal((await app.request('/api/admin/works/invalid', { method: 'DELETE' })).status, 404);
  assert.deepEqual(updates, []);
});

test('both removal routes require admin privileges', async () => {
  const { app, updates } = setup([], 'member');
  assert.equal((await removeChapter(app)).status, 403);
  assert.equal((await app.request(`/api/admin/works/${WORK}`, { method: 'DELETE' })).status, 403);
  assert.deepEqual(updates, []);
});

test('publication detects a deletion-only draft from immutable snapshots', () => {
  const previous = { revisions: new Map([['a', 'ra'], ['b', 'rb']]), positions: new Map([['a', 1], ['b', 2]]) };
  assert.deepEqual(classify([{ chapterId: 'b', revisionId: 'rb', position: 2 }], previous), {
    newChapterIds: [], updatedChapterIds: [], reorderedChapterIds: [], removedChapterIds: ['a'],
  });
});
