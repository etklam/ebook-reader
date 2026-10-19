import pg from 'pg';
import { writeFile } from 'node:fs/promises';
if (!process.argv[2]) throw new Error('usage: node scripts/perf-indexes.mjs output.json (MIGRATOR_DATABASE_URL required)');
const pool=new pg.Pool({connectionString:process.env.MIGRATOR_DATABASE_URL});
const db=await pool.connect();
try {
 await db.query('begin');
 const definitions=(await db.query("select indexname,indexdef from pg_indexes where schemaname='app' and indexname in ('chapters_work_position_idx','chapters_work_position_uq','user_follows_user_idx','user_follows_user_id_work_id_pk') order by indexname")).rows;
 const stats=(await db.query("select indexrelname,idx_scan from pg_stat_user_indexes where schemaname='app' and indexrelname in ('chapters_work_position_idx','chapters_work_position_uq','user_follows_user_idx','user_follows_user_id_work_id_pk')")).rows;
 await db.query('create temp table bench_chapters (id uuid default gen_random_uuid(),work_id uuid not null,editorial_position int not null, unique(work_id,editorial_position) deferrable initially deferred)');
 await db.query('create index bench_chapters_duplicate on bench_chapters(work_id,editorial_position)');
 await db.query("insert into bench_chapters(work_id,editorial_position) select ('00000000-0000-0000-0000-'||lpad(w::text,12,'0'))::uuid,n from generate_series(1,20) w cross join generate_series(1,5000) n");
 await db.query('create temp table bench_follows (user_id uuid not null, work_id uuid not null, primary key(user_id,work_id))');
 await db.query('create index bench_follows_duplicate on bench_follows(user_id)');
 await db.query("insert into bench_follows select ('00000000-0000-0000-0000-'||lpad(u::text,12,'0'))::uuid, ('00000000-0000-0000-0000-'||lpad(w::text,12,'0'))::uuid from generate_series(1,1000) u cross join generate_series(1,20) w");
 await db.query('analyze bench_chapters');await db.query('analyze bench_follows');
 const queries={toc:"select id from bench_chapters where work_id='00000000-0000-0000-0000-000000000001' and editorial_position>=2500 order by editorial_position limit 100",locate:"select id from bench_chapters where work_id='00000000-0000-0000-0000-000000000001' and editorial_position=2500",follows:"select work_id from bench_follows where user_id='00000000-0000-0000-0000-000000000001'"};
 async function measure(){
  const plans={};for(const [key,sql]of Object.entries(queries)){plans[key]=(await db.query('explain (analyze,buffers,format json) '+sql)).rows[0]['QUERY PLAN'][0];}
  const insertMs=[];
  for(let i=0;i<7;i++){await db.query('savepoint trial');const start=performance.now();await db.query("insert into bench_chapters(work_id,editorial_position) select '00000000-0000-0000-0000-000000000001',n from generate_series(5001,6000)n");insertMs.push(performance.now()-start);await db.query('rollback to trial');}
  return {plans,insertMs,medianInsertMs:insertMs.sort((a,b)=>a-b)[3]};
 }
 const before=await measure();await db.query('drop index bench_chapters_duplicate');await db.query('drop index bench_follows_duplicate');const after=await measure();
 const result={recordedAt:new Date().toISOString(),environment:'local PostgreSQL 18; temp tables, 20 works × 5000 chapters; 1000 users × 20 follows; warm cache; seven 1000-chapter insert trials, transaction rolled back',definitions,stats,before,after};
 await writeFile(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify({beforeInsertMs:before.medianInsertMs,afterInsertMs:after.medianInsertMs,afterPlans:Object.fromEntries(Object.entries(after.plans).map(([k,v])=>[k,v.Plan]))}));
} finally {await db.query('rollback');db.release();await pool.end();}
