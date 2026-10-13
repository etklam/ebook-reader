import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import { rankingRoutes } from './rankings.ts';

function setup() {
  const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
  const db = { execute: async (query: SQL) => {
    queries.push(new PgDialect().sqlToQuery(query));
    return { rows: [{ id: 'work', title: '作品', author: '作者', work_type: 'serial',
      serial_status: 'ongoing', chapter_count: 10, score: '12' }] };
  } } as unknown as NodePgDatabase;
  return { app: rankingRoutes({ db, trustProxy: false }), queries };
}

test('rankings validate type and period before querying', async () => {
  const { app, queries } = setup();
  for (const query of ['type=unknown', 'period=unknown', 'period=toString', 'serialStatus=invalid', 'categoryId=invalid']) {
    assert.equal((await app.request(`/api/rankings?${query}`)).status, 400);
  }
  assert.equal(queries.length, 0);
});

test('both rankings support rolling Taipei dates and unrestricted totals', async () => {
  for (const type of ['clicks', 'favorites']) {
    for (const [period, days] of [['week', 7], ['month', 30], ['year', 365], ['all', null]] as const) {
      const { app, queries } = setup();
      const res = await app.request(`/api/rankings?type=${type}&period=${period}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.type, type);
      assert.equal(body.period, period);
      assert.equal(body.days, days);
      assert.equal(body.works[0][type], 12);
      assert.equal(body.works[0][type === 'clicks' ? 'favorites' : 'clicks'], 0);
      const query = queries[0];
      assert.ok(query.sql.includes(type === 'clicks' ? 'app.work_clicks' : 'app.user_library'));
      assert.ok(query.sql.includes("w.visibility = 'public'"));
      assert.ok(query.sql.includes('r.work_id = w.id'));
      assert.ok(query.sql.includes('order by count(*) desc, w.title asc, w.id asc limit 50'));
      if (days === null) {
        assert.deepEqual(query.params, []);
        assert.ok(!query.sql.includes('::date'));
      } else {
        assert.deepEqual(query.params, [days - 1]);
        assert.ok(query.sql.includes("Asia/Taipei"));
        assert.ok(query.sql.includes(type === 'clicks' ? 'v.day' : 'v.created_at'));
        assert.ok(!query.sql.includes('v.updated_at'));
      }
    }
  }
});

test('rankings preserve the default weekly click leaderboard', async () => {
  const { app } = setup();
  const body = await (await app.request('/api/rankings')).json();
  assert.equal(body.type, 'clicks');
  assert.equal(body.period, 'week');
  assert.equal(body.days, 7);
});


test('ranking status and category filters constrain both leaderboard types', async () => {
  const category = '11111111-1111-4111-8111-111111111111';
  for (const type of ['clicks', 'favorites']) {
    const { app, queries } = setup();
    const res = await app.request(`/api/rankings?type=${type}&period=all&serialStatus=completed&categoryId=${category}`);
    assert.equal(res.status, 200);
    assert.deepEqual(queries[0].params, ['completed', category]);
    assert.ok(queries[0].sql.includes('w.serial_status ='));
    assert.ok(queries[0].sql.includes('wc.work_id = w.id and ct.is_active'));
  }
});
