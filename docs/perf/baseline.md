# 查詢效能基線（M7 Phase 3.4）

**量測日期：2026-10-03｜runs=20／case（取 p50／p95）。**

本檔是基線記錄，不是通過標準。**未加任何新索引**——dev-plan §16A-C
要求先量測再決定，所以任何新索引都必須以這裡的 plan 作為理由。

量測方式：直接驅動 HTTP handler（含 DTO 組裝與繁簡變體查詢），
不是只跑 SQL；因此數字包含應用層成本。單一 process、本機 Docker PostgreSQL，
**不是生產環境壓測**。

## 資料規模

| 項目 | 筆數 |
| --- | --- |
| works | 5063 |
| listed | 4753 |
| chapters | 58210 |
| revisions | 58266 |
| work_tags | 54979 |
| work_categories | 15003 |
| release_items | 47691 |

## 環境

```
PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
effective_cache_size = 5242888kB
max_connections = 50
random_page_cost = 4
shared_buffers = 655368kB
work_mem = 4096kB
```

## API 量測

| 查詢 | 狀態 | 回傳 | p50 (ms) | p95 (ms) | max (ms) |
| --- | --- | --- | --- | --- | --- |
| catalog: unfiltered, first page | 200 | 20 | 4.9 | 6.4 | 6.8 |
| catalog: sort=title | 200 | 20 | 3.7 | 5.4 | 5.5 |
| catalog: type filter | 200 | 20 | 5.6 | 5.9 | 6.0 |
| catalog: serial status OR | 200 | 20 | 6.0 | 6.4 | 6.7 |
| catalog: category OR (2) | 200 | 20 | 5.1 | 6.0 | 6.8 |
| catalog: tag ANY (3) | 200 | 20 | 3.5 | 4.9 | 5.1 |
| catalog: tag ALL (3) | 200 | 20 | 11.0 | 12.6 | 13.3 |
| catalog: tag ALL + category + status | 200 | 9 | 10.3 | 11.2 | 12.3 |
| catalog: keyword (short, 2 chars) | 200 | 20 | 23.5 | 31.1 | 32.1 |
| catalog: keyword (long, 6 chars) | 200 | 20 | 21.0 | 23.8 | 24.0 |
| catalog: keyword + tag ALL | 200 | 20 | 41.4 | 69.1 | 155.5 |
| count: unfiltered | 200 | 4753 | 2.1 | 2.6 | 2.8 |
| count: tag ALL (3) | 200 | 166 | 8.5 | 9.1 | 9.5 |
| count: keyword + tag ALL | 200 | 166 | 33.2 | 39.6 | 40.8 |
| taxonomy: public tag list | 200 | 200 | 1.5 | 2.0 | 2.0 |
| work detail | 200 | 1 | 1.5 | 2.1 | 2.1 |
| reader: work metadata | 200 | 1 | 0.8 | 0.9 | 0.9 |
| reader: TOC page | 200 | 180 | 1.0 | 1.2 | 1.4 |
| reader: chapter | 200 | 1 | 1.5 | 1.7 | 1.8 |

## 查詢計劃

### tag ALL (3) + public + released, keyset page

```
Limit  (cost=2532.02..3336.06 rows=21 width=52) (actual time=10.081..10.217 rows=21.00 loops=1)
  Buffers: shared hit=1716
  ->  Nested Loop Anti Join  (cost=2532.02..82782.83 rows=2096 width=52) (actual time=10.081..10.215 rows=21.00 loops=1)
        Join Filter: (NOT (ANY ((w.id = (hashed SubPlan 2).col1) AND (x.id = (hashed SubPlan 2).col2))))
        Rows Removed by Join Filter: 84
        Buffers: shared hit=1716
        ->  Gather Merge  (cost=2532.02..3009.90 rows=4193 width=52) (actual time=2.895..2.954 rows=542.00 loops=1)
              Workers Planned: 1
              Workers Launched: 1
              Buffers: shared hit=1257
              ->  Sort  (cost=1532.01..1538.18 rows=2466 width=52) (actual time=1.248..1.254 rows=271.00 loops=2)
                    Sort Key: wr.published_at DESC, w.id
                    Sort Method: quicksort  Memory: 527kB
                    Buffers: shared hit=1257
                    Worker 0:  Sort Method: quicksort  Memory: 25kB
                    ->  Hash Join  (cost=174.94..1393.08 rows=2466 width=52) (actual time=0.335..1.026 rows=2376.50 loops=2)
                          Hash Cond: (w.active_release_id = wr.id)
                          Buffers: shared hit=1242
                          ->  Parallel Seq Scan on works w  (cost=0.00..1211.23 rows=2627 width=60) (actual time=0.002..0.472 rows=2376.50 loops=2)
                                Filter: ((active_release_id IS NOT NULL) AND (visibility = 'public'::text))
                                Rows Removed by Filter: 155
                                Buffers: shared hit=1174
                          ->  Hash  (cost=115.53..115.53 rows=4753 width=24) (actual time=0.652..0.652 rows=4753.00 loops=1)
                                Buckets: 8192  Batches: 1  Memory Usage: 324kB
                                Buffers: shared hit=68
                                ->  Seq Scan on work_releases wr  (cost=0.00..115.53 rows=4753 width=24) (actual time=0.011..0.373 rows=4753.00 loops=1)
                                      Buffers: shared hit=68
        ->  Function Scan on unnest x  (cost=0.00..0.03 rows=3 width=16) (actual time=0.000..0.000 rows=1.12 loops=542)
        SubPlan 2
          ->  Seq Scan on work_tags wt  (cost=0.00..1008.79 rows=54979 width=32) (actual time=0.011..2.049 rows=54979.00 loops=1)
                Buffers: shared hit=459
Planning:
  Buffers: shared hit=105
Planning Time: 0.382 ms
Execution Time: 10.330 ms
```

### count with tag ALL (3)

```
Aggregate  (cost=81323.00..81323.01 rows=1 width=8) (actual time=8.495..8.495 rows=1.00 loops=1)
  Buffers: shared hit=1701
  ->  Sort  (cost=81312.52..81317.76 rows=2096 width=16) (actual time=8.485..8.489 rows=166.00 loops=1)
        Sort Key: w.id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=1701
        ->  Nested Loop Anti Join  (cost=174.94..81196.89 rows=2096 width=16) (actual time=6.976..8.472 rows=166.00 loops=1)
              Join Filter: (NOT (ANY ((w.id = (hashed SubPlan 2).col1) AND (x.id = (hashed SubPlan 2).col2))))
              Rows Removed by Join Filter: 667
              Buffers: shared hit=1701
              ->  Hash Join  (cost=174.94..1423.96 rows=4193 width=16) (actual time=0.356..1.295 rows=4753.00 loops=1)
                    Hash Cond: (w.active_release_id = wr.id)
                    Buffers: shared hit=1242
                    ->  Seq Scan on works w  (cost=0.00..1237.29 rows=4466 width=32) (actual time=0.005..0.633 rows=4753.00 loops=1)
                          Filter: ((active_release_id IS NOT NULL) AND (visibility = 'public'::text))
                          Rows Removed by Filter: 310
                          Buffers: shared hit=1174
                    ->  Hash  (cost=115.53..115.53 rows=4753 width=16) (actual time=0.349..0.349 rows=4753.00 loops=1)
                          Buckets: 8192  Batches: 1  Memory Usage: 287kB
                          Buffers: shared hit=68
                          ->  Seq Scan on work_releases wr  (cost=0.00..115.53 rows=4753 width=16) (actual time=0.002..0.185 rows=4753.00 loops=1)
                                Buffers: shared hit=68
              ->  Function Scan on unnest x  (cost=0.00..0.03 rows=3 width=16) (actual time=0.000..0.000 rows=1.11 loops=4753)
              SubPlan 2
                ->  Seq Scan on work_tags wt  (cost=0.00..1008.79 rows=54979 width=32) (actual time=0.004..1.909 rows=54979.00 loops=1)
                      Buffers: shared hit=459
Planning:
  Buffers: shared hit=11
Planning Time: 0.128 ms
Execution Time: 8.614 ms
```

### keyword ILIKE across title/author/taxonomy

```
Limit  (cost=160705.37..160705.43 rows=21 width=24) (actual time=11.627..11.629 rows=21.00 loops=1)
  Buffers: shared hit=1248
  ->  Sort  (cost=160705.37..160714.11 rows=3494 width=24) (actual time=4.098..4.099 rows=21.00 loops=1)
        Sort Key: wr.published_at DESC, w.id
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=1248
        ->  Hash Join  (cost=174.94..160611.17 rows=3494 width=24) (actual time=0.870..4.067 rows=500.00 loops=1)
              Hash Cond: (w.active_release_id = wr.id)
              Buffers: shared hit=1248
              ->  Seq Scan on works w  (cost=0.00..160426.45 rows=3722 width=32) (actual time=0.433..3.569 rows=500.00 loops=1)
                    Filter: ((visibility = 'public'::text) AND ((title ~~* '%風起%'::text) OR (author ~~* '%風起%'::text) OR (ANY (id = (hashed SubPlan 2).col1)) OR (ANY (id = (hashed SubPlan 4).col1))))
                    Rows Removed by Filter: 4563
                    Buffers: shared hit=1180
                    SubPlan 2
                      ->  Nested Loop  (cost=84.16..222.61 rows=333 width=16) (actual time=0.111..0.111 rows=0.00 loops=1)
                            Buffers: shared hit=1
                            ->  Seq Scan on categories ct  (cost=0.00..1.56 rows=1 width=16) (actual time=0.111..0.111 rows=0.00 loops=1)
                                  Filter: (display_name ~~* '%風起%'::text)
                                  Rows Removed by Filter: 45
                                  Buffers: shared hit=1
                            ->  Bitmap Heap Scan on work_categories wc  (cost=84.16..216.21 rows=484 width=32) (never executed)
                                  Recheck Cond: (category_id = ct.id)
                                  ->  Bitmap Index Scan on work_categories_reverse_idx  (cost=0.00..84.04 rows=484 width=0) (never executed)
                                        Index Cond: (category_id = ct.id)
                                        Index Searches: 0
                    SubPlan 4
                      ->  Nested Loop  (cost=50.55..480.16 rows=258 width=16) (actual time=0.104..0.105 rows=0.00 loops=1)
                            Buffers: shared hit=5
                            ->  Seq Scan on tags tg  (cost=0.00..7.66 rows=1 width=16) (actual time=0.104..0.104 rows=0.00 loops=1)
                                  Filter: (display_name ~~* '%風起%'::text)
                                  Rows Removed by Filter: 213
                                  Buffers: shared hit=5
                            ->  Bitmap Heap Scan on work_tags wt  (cost=50.55..469.75 rows=275 width=32) (never executed)
                                  Recheck Cond: (tag_id = tg.id)
                                  ->  Bitmap Index Scan on work_tags_reverse_idx  (cost=0.00..50.48 rows=275 width=0) (never executed)
                                        Index Cond: (tag_id = tg.id)
                                        Index Searches: 0
              ->  Hash  (cost=115.53..115.53 rows=4753 width=24) (actual time=0.422..0.422 rows=4753.00 loops=1)
                    Buckets: 8192  Batches: 1  Memory Usage: 324kB
                    Buffers: shared hit=68
                    ->  Seq Scan on work_releases wr  (cost=0.00..115.53 rows=4753 width=24) (actual time=0.008..0.252 rows=4753.00 loops=1)
                          Buffers: shared hit=68
Planning:
  Buffers: shared hit=132
Planning Time: 0.705 ms
JIT:
  Functions: 50
  Options: Inlining false, Optimization false, Expressions true, Deforming true
  Timing: Generation 0.685 ms (Deform 0.280 ms), Inlining 0.000 ms, Optimization 0.428 ms, Emission 7.228 ms, Total 8.341 ms
Execution Time: 21.003 ms
```

### TOC page by release position

```
Limit  (cost=43.22..43.24 rows=10 width=28) (actual time=0.073..0.083 rows=180.00 loops=1)
  Buffers: shared hit=13
  InitPlan 1
    ->  Limit  (cost=0.00..0.26 rows=1 width=16) (actual time=0.004..0.004 rows=1.00 loops=1)
          Buffers: shared hit=2
          ->  Seq Scan on works  (cost=0.00..1224.63 rows=4753 width=16) (actual time=0.004..0.004 rows=1.00 loops=1)
                Filter: (active_release_id IS NOT NULL)
                Buffers: shared hit=2
  ->  Sort  (cost=42.96..42.98 rows=10 width=28) (actual time=0.072..0.076 rows=180.00 loops=1)
        Sort Key: ri.editorial_position
        Sort Method: quicksort  Memory: 37kB
        Buffers: shared hit=13
        ->  Bitmap Heap Scan on release_items ri  (cost=4.49..42.79 rows=10 width=28) (actual time=0.043..0.060 rows=180.00 loops=1)
              Recheck Cond: (release_id = (InitPlan 1).col1)
              Heap Blocks: exact=3
              Buffers: shared hit=10
              ->  Bitmap Index Scan on release_items_position_uq  (cost=0.00..4.49 rows=10 width=0) (actual time=0.037..0.037 rows=180.00 loops=1)
                    Index Cond: (release_id = (InitPlan 1).col1)
                    Index Searches: 1
                    Buffers: shared hit=7
Planning:
  Buffers: shared hit=10
Planning Time: 0.074 ms
Execution Time: 0.095 ms
```

## 重跑方式

```bash
pnpm perf:seed                 # 建合成資料（含 ANALYZE）
pnpm perf:measure --md > docs/perf/baseline.md
pnpm perf:seed --clean         # 清掉；清掉前 pnpm maintenance 的
                               # 缺檔整合性報告會含合成資料
```
