import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Storage } from '../storage.ts';
import { searchExportRoutes } from './search-export.ts';

const workId = '00000000-0000-0000-0000-000000000001';
const releaseId = '00000000-0000-0000-0000-000000000002';

function fixture(visibility = 'public', missing = false) {
  const filters: SQL[] = [];
  const chapters = Array.from({ length: 55 }, (_, i) => ({
    chapterId: `chapter-${i}`, revisionId: `revision-${i}`, labelRaw: `第${i}章`, title: '', contentKey: String(i),
  }));
  let selectCount = 0;
  const db = {
    select() {
      const rows = selectCount++ === 0 ? [{ id: workId, visibility, activeReleaseId: releaseId }] : chapters;
      const chain = {
        from() { return chain; }, innerJoin() { return chain; },
        where(filter: SQL) { filters.push(filter); return chain; },
        limit() { return Promise.resolve(rows); }, orderBy() { return Promise.resolve(rows); },
      };
      return chain;
    },
  } as unknown as NodePgDatabase;
  const storage = { async get() {
    if (missing) throw new Error('missing');
    return Buffer.from('序言\n\n小龍出現了。');
  } } as unknown as Storage;
  return { app: searchExportRoutes({ db, storage }), filters };
}

test('search route pages in release order and links exact canonical paragraph/revision', async () => {
  const { app, filters } = fixture();
  const response = await app.request(`/api/reader/works/${workId}/search?q=小龙&offset=50`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.total, 55);
  assert.equal(data.offset, 50);
  assert.equal(data.nextOffset, null);
  assert.equal(data.results.length, 5);
  assert.equal(data.results[0].chapterId, 'chapter-50');
  assert.equal(data.results[0].href, `/read/${workId}/chapter-50#p=1&rev=revision-50`);
  assert.deepEqual(new PgDialect().sqlToQuery(filters[1]).params, [releaseId]);
  const first = await (await fixture().app.request(`/api/reader/works/${workId}/search?q=小龍`)).json();
  assert.equal(first.results.length, 50);
  assert.equal(first.nextOffset, 50);
});

test('search validates limits, forbids draft/removed content and reports unavailable storage', async () => {
  for (const query of ['q=', `q=${'a'.repeat(101)}`, 'q=a&offset=-1', 'q=a&offset=1.2']) {
    assert.equal((await fixture().app.request(`/api/reader/works/${workId}/search?${query}`)).status, 400);
  }
  assert.equal((await fixture('draft').app.request(`/api/reader/works/${workId}/search?q=a`)).status, 403);
  assert.equal((await fixture('removed').app.request(`/api/reader/works/${workId}/search?q=a`)).status, 404);
  assert.equal((await fixture('public', true).app.request(`/api/reader/works/${workId}/search?q=a`)).status, 409);
});


test('book search rate-limits repeated requests before scanning storage', async () => {
  const { app, filters } = fixture();
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.request('/api/reader/works/invalid/search?q=a')).status, 404);
  }
  const response = await app.request(`/api/reader/works/${workId}/search?q=a`);
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.equal(filters.length, 0);
});
