import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

// The generation belongs to TOC content, independent of reversible edit_version.
test('TOC generations cover bulk insert/update/delete and never reuse a reverted version', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  const work = randomUUID();
  try {
    await db.query('begin');
    await db.query("insert into app.works(id,title,work_type) values($1,'Generation regression','serial')", [work]);
    const generation = async () => (await db.query('select toc_version from app.works where id=$1', [work])).rows[0].toc_version;
    const versions = [await generation()];
    await db.query("insert into app.chapters(work_id,label_raw,editorial_position) select $1,'Chapter',n from generate_series(1,5000)n", [work]);
    versions.push(await generation());
    await db.query("update app.chapters set label_raw='Renamed' where work_id=$1", [work]);
    versions.push(await generation());
    await db.query('update app.works set edit_version=2 where id=$1', [work]);
    await db.query('update app.chapters set editorial_position=editorial_position+10000 where work_id=$1', [work]);
    versions.push(await generation());
    await db.query('update app.works set edit_version=1 where id=$1', [work]);
    await db.query('update app.chapters set editorial_position=editorial_position-10000 where work_id=$1', [work]);
    versions.push(await generation());
    await db.query('delete from app.chapters where work_id=$1 and editorial_position=5000', [work]);
    versions.push(await generation());
    assert.equal(new Set(versions).size, versions.length);
    // Updating work metadata alone must not churn chapter pagination.
    await db.query("update app.works set description='Metadata only' where id=$1", [work]);
    assert.equal(await generation(), versions.at(-1));
  } finally { await db.query('rollback'); db.release(); await pool.end(); }
});
