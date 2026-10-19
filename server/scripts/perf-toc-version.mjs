// Compare the original head content hash with a stored generation, same TOC
// projection/window/page, real PG fixture. Does not modify production data.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
if (!process.argv[2]) throw new Error('usage: node scripts/perf-toc-version.mjs output.json (MIGRATOR_DATABASE_URL required)');
const pool = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
const db = await pool.connect();
const work = randomUUID();
try {
  await db.query('begin');
  await db.query("insert into app.works(id,title,work_type) values($1,'TOC performance','serial')", [work]);
  await db.query("insert into app.chapters(work_id,label_raw,editorial_position) select $1,'第'||n||'章',n from generate_series(1,5000)n", [work]);
  await db.query("insert into app.chapter_revisions(chapter_id,title,content_key,body_compare_hash,revision_hash,processor_version) select id,'故事','not-read',id::text,id::text,'bench' from app.chapters where work_id=$1", [work]);
  await db.query('update app.chapters c set head_revision_id=r.id from app.chapter_revisions r where r.chapter_id=c.id and c.work_id=$1', [work]);
  const queries = {};
  for (const mode of ['before', 'after']) {
    const version = mode === 'before' ? "'head:'||md5(coalesce((select string_agg(row(base.*)::text,',' order by \"editorialPosition\") from base),''))" : "'head:'||(select toc_version from app.works where id=$1)";
    const sql = `with base as (select c.id,c.volume_id as "volumeId",c.label_raw as "labelRaw",coalesce(r.title,'') as title,c.editorial_position as "editorialPosition",c.head_revision_id as "revisionId" from app.chapters c left join app.chapter_revisions r on r.id=c.head_revision_id where c.work_id=$1 and c.merged_into_chapter_id is null),
      ranked as (select *, (row_number() over(order by "editorialPosition")-1)::int ordinal from base),
      stats as(select count(*)::int total, ${version} version from ranked)
      select total,version,(select json_agg(ranked) from ranked where ordinal>=2450 and ordinal<2550) chapters from stats`;
    const samples=[];
    for(let n=0;n<12;n++){const start=performance.now();await db.query(sql,[work]);if(n>=2)samples.push(performance.now()-start);}
    samples.sort((a,b)=>a-b);
    queries[mode]={p50Ms:samples[5],p95Ms:samples[9],samples:10,plan:(await db.query('explain(analyze,buffers,format json) '+sql,[work])).rows[0]['QUERY PLAN'][0]};
  }
  const result={recordedAt:new Date().toISOString(),environment:'local PostgreSQL 18, 5000 real metadata rows and revisions, same window/projection, warm cache, no storage reads; isolated rolled-back fixture',queries};
  await writeFile(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify({before:queries.before.p95Ms,after:queries.after.p95Ms}));
}finally{await db.query('rollback');db.release();await pool.end();}
