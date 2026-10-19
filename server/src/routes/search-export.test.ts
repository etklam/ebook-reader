import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Storage } from '../storage.ts';
import { searchExportRoutes } from './search-export.ts';
import { works, chapters as chapterTable } from '../db/schema.ts';

const workId = '00000000-0000-0000-0000-000000000001';
const releaseId = '00000000-0000-0000-0000-000000000002';

function fixture(visibility = 'public', missing = false, count = 55, hits?: Set<number>) {
  const filters: SQL[] = [];
  const chapters = Array.from({ length: count }, (_, i) => ({
    chapterId: `chapter-${i}`, revisionId: `revision-${i}`, labelRaw: `第${i}章`, title: '', contentKey: String(i),
  }));
  const work = { id: workId, visibility, activeReleaseId: releaseId, editVersion: 0 };
  const db = {
    select() {
      let rows: unknown[] = [];
      const chain = {
        from(table: unknown) { rows = table === works ? [work] : chapters; return chain; }, innerJoin() { return chain; },
        where(filter: SQL) { filters.push(filter); return chain; },
        limit() { return Promise.resolve(rows); }, orderBy() { return Promise.resolve(rows); },
      };
      return chain;
    },
  } as unknown as NodePgDatabase;
  const reads: string[] = [];
  const storage = { async get(key: string) {
    reads.push(key);
    if (missing) throw new Error('missing');
    return Buffer.from(!hits || hits.has(Number(key)) ? '序言\n\n小龍出現了。' : '沒有搜尋用字');
  } } as unknown as Storage;
  return { app: searchExportRoutes({ db, storage }), filters, reads, work, chapters, storage };
}

test('search route pages in release order and links exact canonical paragraph/revision', async () => {
  const { app, filters } = fixture();
  const first = await (await app.request(`/api/reader/works/${workId}/search?q=小龙`)).json();
  assert.equal(first.total, null);
  assert.equal(first.results.length, 50);
  assert.equal(first.hasMore, true);
  const response = await app.request(`/api/reader/works/${workId}/search?q=小龙&cursor=${first.nextCursor}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.total, null);
  assert.equal(data.offset, 50);
  assert.equal(data.nextCursor, null);
  assert.equal(data.hasMore, false);
  assert.equal(data.results.length, 5);
  assert.equal(data.results[0].chapterId, 'chapter-50');
  assert.equal(data.results[0].href, `/read/${workId}/chapter-50#p=1&rev=revision-50`);
  assert.deepEqual(new PgDialect().sqlToQuery(filters[1]).params, [releaseId]);
});

test('dense results stop in bounded batches, subsequent pages retain lookahead without rescanning prefix', async () => {
  const { app, reads } = fixture('public', false, 500);
  let cursor: string | null = null;
  const seen: string[] = [];
  for (let page = 0; page < 3; page++) {
    reads.length = 0;
    const response = await app.request(`/api/reader/works/${workId}/search?q=小龍${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.offset, page * 50);
    assert.equal(reads[0], String(page * 50));
    assert.ok(reads.length <= 56);
    assert.equal(data.results[0].chapterId, `chapter-${page * 50}`);
    seen.push(...data.results.map((row: { chapterId: string }) => row.chapterId));
    cursor = data.nextCursor;
  }
  assert.equal(new Set(seen).size, 150);
});

test('cursor rejects corrupt, query/work mismatch and changed active revision sets', async () => {
  const { app, work, chapters } = fixture();
  const first = await (await app.request(`/api/reader/works/${workId}/search?q=小龍`)).json();
  const altered = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  altered.n += 1;
  for (const [query, expected] of [
    [`q=小龍&cursor=broken`, 'invalid_cursor'],
    [`q=小龍&cursor=${Buffer.from(JSON.stringify(altered)).toString('base64url')}`, 'invalid_cursor'],
    [`q=別的&cursor=${first.nextCursor}`, 'cursor_filter_mismatch'],
  ]) {
    const response = await app.request(`/api/reader/works/${workId}/search?${query}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, expected);
  }
  work.activeReleaseId = '00000000-0000-0000-0000-000000000099';
  const changed = await app.request(`/api/reader/works/${workId}/search?q=小龍&cursor=${first.nextCursor}`);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, 'search_version_changed');
  work.activeReleaseId = releaseId; chapters[1].revisionId = 'new-revision';
  assert.equal((await app.request(`/api/reader/works/${workId}/search?q=小龍&cursor=${first.nextCursor}`)).status, 409);
  chapters.splice(10);
  const shortened = await app.request(`/api/reader/works/${workId}/search?q=小龍&cursor=${first.nextCursor}`);
  assert.equal(shortened.status, 409, 'a shorter new version is a version conflict, not a corrupt cursor');
});

test('zero, boundary, sparse and last-chapter matches have honest page existence', async () => {
  for (const count of [0, 49, 50, 51]) {
    const data = await (await fixture('public', false, count).app.request(`/api/reader/works/${workId}/search?q=小龍`)).json();
    assert.equal(data.results.length, Math.min(count, 50));
    assert.equal(data.hasMore, count > 50);
    assert.equal(data.total, null);
  }
  const sparse = fixture('public', false, 121, new Set([120]));
  const data = await (await sparse.app.request(`/api/reader/works/${workId}/search?q=小龍`)).json();
  assert.equal(data.results[0].chapterId, 'chapter-120');
  assert.equal(data.hasMore, false);
  assert.equal(sparse.reads.length, 121);
});

test('search validates limits, forbids draft/removed content and reports unavailable storage', async () => {
  for (const query of ['q=', `q=${'a'.repeat(101)}`, 'q=a&offset=-1', 'q=a&offset=1.2', 'q=a&offset=50']) {
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

test('body candidate rejection preserves a title-only hit without reading canonical bodies', async () => {
  const { app, storage, chapters, reads } = fixture('public', false, 3);
  storage.searchCandidate = async () => false;
  chapters[2].title = 'Title-only keyword';
  const response = await app.request(`/api/reader/works/${workId}/search?q=keyword`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].chapterId, 'chapter-2');
  assert.equal(body.results[0].paragraphIndex, 0);
  assert.deepEqual(reads, []);
});

test('export route rejects over-budget data before reads and admits one serializer at a time', async () => {
  const { EXPORT_MAX_BYTES } = await import('../export/formatters.ts');
  const work = { id: workId, title: 'Export test', author: null, description: null, visibility: 'draft' };
  const chapter = { chapterId: 'c', revisionId: 'r', contentKey: 'body', title: 'Chapter', labelRaw: '1' };
  const db = { select() {
    let rows: unknown[] = [];
    const chain = {
      from(table: unknown) { rows = table === works ? [work] : table === chapterTable ? [chapter] : []; return chain; },
      leftJoin() { return chain; }, where() { return chain; },
      limit() { return Promise.resolve(rows); }, orderBy() { return Promise.resolve(rows); },
      then(resolve: (value: unknown[]) => unknown) { return Promise.resolve(rows).then(resolve); },
    }; return chain;
  } } as unknown as NodePgDatabase;
  let bytes = EXPORT_MAX_BYTES + 1;
  let reads = 0;
  let release!: (value: Buffer) => void;
  const storage = {
    async size() { return bytes; },
    async get() { reads++; return new Promise<Buffer>(resolve => { release = resolve; }); },
  } as unknown as Storage;
  const app = searchExportRoutes({ db, storage });
  const path = `/api/admin/works/${workId}/export?version=head&format=txt`;
  const rejected = await app.request(path);
  assert.equal(rejected.status, 413); assert.equal((await rejected.json()).error, 'export_too_large');
  assert.equal(reads, 0);
  bytes = 5;
  const first = app.request(path);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  const busy = await app.request(path);
  assert.equal(busy.status, 429); assert.equal((await busy.json()).error, 'export_busy');
  assert.equal(busy.headers.get('retry-after'), '5');
  release(Buffer.from('hello'));
  const completed = await first;
  assert.equal(completed.status, 200); assert.match(await completed.text(), /hello/);
});
