// Query measurement (M7 Phase 3.4 / CAT-T5, DB-T4).
//
//   pnpm --filter server perf:seed
//   pnpm --filter server perf:measure            # table to stdout
//   pnpm --filter server perf:measure --md > ../docs/perf/baseline.md
//
// Measures the REAL queries by driving the HTTP handlers, then captures
// EXPLAIN (ANALYZE, BUFFERS) for the equivalent SQL so a later regression can
// be compared plan-to-plan and not just number-to-number.
//
// Deliberately measured BEFORE adding any index: dev-plan §16A-C says to
// measure and then decide, so an index must be justified by a plan in here.
import { Pool } from 'pg';

const args = process.argv.slice(2);
const asMarkdown = args.includes('--md');
const RUNS = Number(args.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 20);

process.env.STORAGE_ROOT ??= './storage';
const { app } = await import('../src/index.ts');

const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 2 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const scale = (await q(`
  select
    (select count(*)::int from app.works) works,
    (select count(*)::int from app.works where visibility='public' and active_release_id is not null) listed,
    (select count(*)::int from app.chapters) chapters,
    (select count(*)::int from app.chapter_revisions) revisions,
    (select count(*)::int from app.work_tags) work_tags,
    (select count(*)::int from app.work_categories) work_categories,
    (select count(*)::int from app.release_items) release_items`))[0];

// Taxonomy ids that CO-OCCUR on a real work. Picking the first three tags
// alphabetically gave an ALL-filter that matched nothing, so the planner
// short-circuited and the measurement said nothing about the expensive path.
// Measuring the cheap-because-empty case is worse than not measuring.
const tags = (await q(`
  select wt.tag_id as id
  from app.work_tags wt
  where wt.work_id = (
    select work_id from app.work_tags group by work_id having count(*) >= 3 limit 1)
  limit 3`)).map((r) => r.id);
const cats = (await q(`
  select wc.category_id as id
  from app.work_categories wc
  where wc.work_id = (
    select work_id from app.work_categories group by work_id having count(*) >= 2 limit 1)
  limit 2`)).map((r) => r.id);
if (tags.length < 3 || cats.length < 2) {
  console.error('not enough taxonomy assignments to measure; run `pnpm perf:seed` first');
  process.exit(1);
}
const [sampleWork] = await q(
  `select id from app.works where visibility='public' and active_release_id is not null limit 1`);
const [sampleChapter] = await q(
  `select ri.chapter_id from app.release_items ri
   join app.works w on w.active_release_id = ri.release_id limit 1`);

const CASES = [
  ['catalog: unfiltered, first page', '/api/works?limit=20'],
  ['catalog: sort=title', '/api/works?limit=20&sort=title'],
  ['catalog: type filter', '/api/works?limit=20&type=serial'],
  ['catalog: serial status OR', '/api/works?limit=20&serialStatus=ongoing,completed'],
  ['catalog: category OR (2)', `/api/works?limit=20&categoryIds=${cats.join(',')}`],
  ['catalog: tag ANY (3)', `/api/works?limit=20&tagIds=${tags.join(',')}&tagMode=any`],
  ['catalog: tag ALL (3)', `/api/works?limit=20&tagIds=${tags.join(',')}&tagMode=all`],
  ['catalog: tag ALL + category + status', `/api/works?limit=20&tagIds=${tags.join(',')}&tagMode=all&categoryIds=${cats.join(',')}&serialStatus=ongoing`],
  ['catalog: keyword (short, 2 chars)', '/api/works?limit=20&q=%E9%A2%A8%E8%B5%B7'],
  ['catalog: keyword (long, 6 chars)', '/api/works?limit=20&q=perfseed-%E4%BD%9C%E5%93%81'],
  ['catalog: keyword + tag ALL', `/api/works?limit=20&q=perfseed&tagIds=${tags.join(',')}&tagMode=all`],
  ['count: unfiltered', '/api/works/count'],
  ['count: tag ALL (3)', `/api/works/count?tagIds=${tags.join(',')}&tagMode=all`],
  ['count: keyword + tag ALL', `/api/works/count?q=perfseed&tagIds=${tags.join(',')}&tagMode=all`],
  ['taxonomy: public tag list', '/api/taxonomy/tags'],
  ['work detail', sampleWork ? `/api/works/${sampleWork.id}` : null],
  ['reader: work metadata', sampleWork ? `/api/reader/works/${sampleWork.id}` : null],
  ['reader: TOC page', sampleWork ? `/api/reader/works/${sampleWork.id}/chapters?limit=200` : null],
  ['reader: chapter', sampleChapter ? `/api/reader/chapters/${sampleChapter.chapter_id}` : null],
].filter(([, url]) => url !== null);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const results = [];
for (const [name, url] of CASES) {
  // one warm-up so first-call module loading (opencc) is not counted as query time
  const warm = await app.request(url);
  const status = warm.status;
  await warm.text();

  const times = [];
  let rows = 0;
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    const res = await app.request(url);
    const body = await res.text();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (i === 0) {
      try {
        const parsed = JSON.parse(body);
        rows = Array.isArray(parsed.works) ? parsed.works.length
          : Array.isArray(parsed.chapters) ? parsed.chapters.length
            : Array.isArray(parsed.items) ? parsed.items.length
              : typeof parsed.count === 'number' ? parsed.count : 1;
      } catch { rows = 0; }
    }
  }
  times.sort((a, b) => a - b);
  results.push({
    name,
    url,
    status,
    rows,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times[times.length - 1],
  });
}

// --- plans for the two shapes most likely to regress --------------------------
const planQueries = [
  ['tag ALL (3) + public + released, keyset page', `
    select w.id, w.title, wr.published_at
    from app.works w
    join app.work_releases wr on wr.id = w.active_release_id
    where w.visibility = 'public' and w.active_release_id is not null
      and not exists (
        select x from unnest($1::uuid[]) as x(id)
        where not exists (
          select 1 from app.work_tags wt where wt.work_id = w.id and wt.tag_id = x.id))
    order by wr.published_at desc, w.id asc
    limit 21`, [tags]],
  ['count with tag ALL (3)', `
    select count(distinct w.id)
    from app.works w
    join app.work_releases wr on wr.id = w.active_release_id
    where w.visibility = 'public' and w.active_release_id is not null
      and not exists (
        select x from unnest($1::uuid[]) as x(id)
        where not exists (
          select 1 from app.work_tags wt where wt.work_id = w.id and wt.tag_id = x.id))`, [tags]],
  ['keyword ILIKE across title/author/taxonomy', `
    select w.id
    from app.works w
    join app.work_releases wr on wr.id = w.active_release_id
    where w.visibility = 'public'
      and (w.title ilike $1 or w.author ilike $1
        or exists (select 1 from app.work_categories wc join app.categories ct on ct.id = wc.category_id
                   where wc.work_id = w.id and ct.display_name ilike $1)
        or exists (select 1 from app.work_tags wt join app.tags tg on tg.id = wt.tag_id
                   where wt.work_id = w.id and tg.display_name ilike $1))
    order by wr.published_at desc, w.id asc
    limit 21`, ['%風起%']],
  ['TOC page by release position', `
    select ri.chapter_id, ri.label_raw, ri.editorial_position
    from app.release_items ri
    where ri.release_id = (select active_release_id from app.works
                           where active_release_id is not null limit 1)
    order by ri.editorial_position
    limit 200`, []],
];

const plans = [];
for (const [name, sql, params] of planQueries) {
  const rows = await q(`explain (analyze, buffers, verbose off) ${sql}`, params);
  plans.push({ name, plan: rows.map((r) => r['QUERY PLAN']).join('\n') });
}

const [{ version }] = await q('select version()');
const settings = await q(`
  select name, setting, unit from pg_settings
  where name in ('shared_buffers','work_mem','effective_cache_size','random_page_cost','max_connections')
  order by name`);

if (asMarkdown) {
  const now = new Date().toISOString().slice(0, 10);
  console.log(`# 查詢效能基線（M7 Phase 3.4）\n`);
  console.log(`**量測日期：${now}｜runs=${RUNS}／case（取 p50／p95）。**\n`);
  console.log(`本檔是基線記錄，不是通過標準。**未加任何新索引**——dev-plan §16A-C`);
  console.log(`要求先量測再決定，所以任何新索引都必須以這裡的 plan 作為理由。\n`);
  console.log(`量測方式：直接驅動 HTTP handler（含 DTO 組裝與繁簡變體查詢），`);
  console.log(`不是只跑 SQL；因此數字包含應用層成本。單一 process、本機 Docker PostgreSQL，`);
  console.log(`**不是生產環境壓測**。\n`);
  console.log(`## 資料規模\n`);
  console.log('| 項目 | 筆數 |');
  console.log('| --- | --- |');
  for (const [k, v] of Object.entries(scale)) console.log(`| ${k} | ${v} |`);
  console.log(`\n## 環境\n`);
  console.log('```');
  console.log(version);
  for (const s of settings) console.log(`${s.name} = ${s.setting}${s.unit ?? ''}`);
  console.log('```');
  console.log(`\n## API 量測\n`);
  console.log('| 查詢 | 狀態 | 回傳 | p50 (ms) | p95 (ms) | max (ms) |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    console.log(`| ${r.name} | ${r.status} | ${r.rows} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.max.toFixed(1)} |`);
  }
  console.log(`\n## 查詢計劃\n`);
  for (const p of plans) {
    console.log(`### ${p.name}\n`);
    console.log('```');
    console.log(p.plan);
    console.log('```\n');
  }
  console.log(`## 重跑方式\n`);
  console.log('```bash');
  console.log('pnpm perf:seed                 # 建合成資料（含 ANALYZE）');
  console.log('pnpm perf:measure --md > docs/perf/baseline.md');
  console.log('pnpm perf:seed --clean         # 清掉；清掉前 pnpm maintenance 的');
  console.log('                               # 缺檔整合性報告會含合成資料');
  console.log('```');
} else {
  console.log('scale:', scale);
  console.table(results.map((r) => ({
    case: r.name, status: r.status, rows: r.rows,
    p50: Number(r.p50.toFixed(1)), p95: Number(r.p95.toFixed(1)),
  })));
  for (const p of plans) {
    console.log(`\n--- ${p.name} ---\n${p.plan}`);
  }
}

await pool.end();
process.exit(0);
