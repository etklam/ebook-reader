# CR-001–013 實作與驗證

實作日期：2026-10-19–20（Asia/Hong_Kong）。範圍為這批 13 張 CR tickets；未更改 ER-007 離線下載或 ER-009 的產品衝突政策。程式、migration、部署設定及本機驗證已交付。production rollout 狀態需另外確認。

`implemented-local` 表示可審查的實作與本機驗證完成；不代表已完成 production 拓撲、CNI 或實體手機驗收。各票驗收清單按最終做法更新，未執行現場項目保留未勾，以下紀錄是已執行證據。

| Ticket | 最終實作／修正後範圍 |
| --- | --- |
| CR-001 | API 只接受單一合法 IP 的 XFF；nginx 從 Traefik 的 X-Real-IP 取來源並覆寫 XFF。production 明確開啟 TRUST_PROXY，新增 web/API ingress NetworkPolicy，部署先套隔離再 rollout。預設 proxy trust 仍關閉。單元測試涵蓋 socket、IPv4、IPv6、鏈狀／損壞／缺失 header。CNI 實際隔離仍是 production gate。 |
| CR-002 | 內部切章以 SPA pushState 建立歷史；分開 work/account 初始化與章節 route effect。支援 back/forward、history entry 的位置、同章 hash、重複開啟同一段落結果。原票重現步驟已修正：舊內部切章使用 replaceState，沒有逐章歷史。 |
| CR-003 | nginx HTML、fallback、assets、404 加 enforce CSP、nosniff、frame denial、Referrer/Permissions Policy、HSTS。共用 include 避免 add_header 繼承遺失。安全加固不代表發現可利用 XSS。 |
| CR-004 | 每個 work 的跨實例 promise queue，初始化與寫入序列化、最新 pending anchor 合併、成功 anchor 去重、真正 409 保留 server-wins。cancel 取消 pending／通知；finish 排空已擷取的最後進度但不呼叫已離開的 UI。同步器不再隨章節重建。 |
| CR-005 | 先量測 5,000 × 100KiB 正文，超過預先採用的 1s p95／100MB 讀取調查門檻，再加入每個 immutable storage object 的持久化 Bloom 候選索引。不是截斷正文，也不是 SQL 文字索引；所有命中仍由原 matcher 產生。短詞、飽和、缺失／損壞索引回完整掃描；無假陰性。保留原可見性、revision、cursor、snippet 與段落契約。 |
| CR-006 | 只影響 admin 草稿的全書 hash 已移除。新增 works.toc_version + statement triggers；每次 chapters bulk insert/update/delete 為受影響 work 產生不可重用 UUID generation。匯入回復不重用 editVersion，發布版仍用 activeReleaseId。不是單調數字版本，但具備所需的失效語義。 |
| CR-007 | 不存在帳號也驗證同參數 dummy hash；兩條失敗路徑都一次 verify、同 401。dummy 常數只在模組建立，不逐請求計算新 hash。 |
| CR-008 | 250ms debounce、AbortController、generation guard，更新時保留既有列。清空、排序、定位立即生效。新增控制時鐘的請求數回歸。 |
| CR-009 | 搜尋結果保留 anchor 語義與 modifier 新分頁操作，普通點擊改 SPA，支援段落深鏈及上一頁。轉章仍依現有語音策略停止舊章；不承諾跨章繼續舊語音或保留舊章 scroll。 |
| CR-010 | 啟用 rules-of-hooks/exhaustive-deps 為 error，修正現有依賴；三處 counter ref cleanup 有局部、附理由的例外。抽出 useReaderEntry、useMemberProgress、useReaderKeyboard，ReaderPage 854 → 777 行。CI 原有 pnpm lint 已涵蓋新規則。 |
| CR-011 | 選方案 A：正文及附件 16MiB，production local storage 先 stat，超限不讀內容，回 413/export_too_large；每 process 同時只 serialize 一本，忙碌回 429/export_busy。EPUB XML escape 與段落組裝分段，避免大量 rope／paragraph 陣列。後台顯示容量／忙碌原因。 |
| CR-012 | hashed assets immutable 1 年、HTML/fallback no-cache、gzip、server_tokens off。缺失 asset 回 404，不回 HTML。55m upload limit 足夠目前 50MiB EPUB，調高 API 上限要同步調整 nginx。 |
| CR-013 | 以 PostgreSQL 暫存表量測後移除兩個重疊索引；保留 deferrable unique 及 follows PK。schema、migration、snapshot 一致。 |

## 已執行檢查

- `pnpm lint`、`pnpm typecheck`、`pnpm build` 通過。Build 仍有既存大型 OpenCC chunk 提醒，沒有建置錯誤。
- `pnpm test`：m0 10、web 45、server 116，共 171 個單元測試通過。實際在允許 child process 的環境執行，避免 Node test worker 受 sandbox 影響。
- `pnpm --filter server test:e2e`：96/96 通過。
- 新增 TOC generation 測試連同既有 TOC/bookmarks 再跑：6/6 通過，涵蓋 5,000 章批次及 editVersion 回復。
- `pnpm db:migrate`、`pnpm db:verify` 通過；`pnpm --filter server db:generate` 回報無 schema 差異。
- Chromium 153、390×844 瀏覽器結果及 CSP 檢查見本文件末的最終驗證補記。
- 真正 nginx 1.28 容器：`pnpm ops:check-web` 通過 HTML、fallback、安全標頭、asset gzip/cache、404、API no-store proxy。
- 修正舊 import-review mock 缺失的 taxonomy 回應；生產 API 契約未改。

## 效能與容量證據

原始數據保存於 `docs/perf/cr-*-2026-10-19.json`。量測跨 10 月 19–20 日，檔名沿用 ticket 批次日期；JSON recordedAt 為 UTC。均為本機資料，不代表 production SLA。

- 搜尋：5,000 章，共 512,000,000 bytes。無命中 p95 單請求 2483 → 286ms，併發 4 為 7742 → 678ms。正文讀取 512MB → 0，另讀取 82.1MB sidecar 索引；索引不是零成本。每組單請求 3 筆、併發 4 共 12 筆，樣本有限。密集兩字詞仍走原有有界正文讀取，不保證加速。
- TOC：版本計算對照查詢（非完整 HTTP endpoint），相同 5,000 metadata rows／window／projection，暖機後 10 筆，p95 約 26.1 → 10.3ms；公開版原本無 hash，不宣稱公開閱讀同幅提升。
- 索引：20 本各 5,000 章；1,000 users 各 20 follows，移除後 TOC／定位使用 unique index，follows 使用 PK bitmap scan；7 次插入 1,000 章的中位數 3.88 → 3.37ms。這不是 production 使用率觀察。
- 匯出：上限 16MiB，fresh child、512MiB V8 heap。EPUB RSS：一般正文約 215MiB、密集 XML escape 約 533MiB、數百萬短段落約 448MiB。原 32MiB 密集 escape 在未分段 formatter 上觸發 heap OOM，因此沒有沿用該上限。這是容量降低風險的證據，不是所有 workload 的絕對記憶體保證。
- 登入：100 次／路徑、交替執行、真實 scrypt、假 DB；缺帳號 median 35.9ms，錯密碼 33.8ms。網路與真實資料庫不在量測內，不宣稱數學上的 constant time。
- 定位：100／5,000 段 90 次查詢，geometry reads 609／1121、p95 0.2／0.5ms。同期其他工作造成長任務樣本，不作真機掉幀結論。
- 預載：真 API、DB、storage，390×844、24px/2；未命中切章新增 1 個正文請求、已預載新增 0。各一筆，約 298／304ms，不宣稱 latency 改善。指定字體大小是為避免 Linux 字體使對照章節短於一屏；短章在章首立即預載是既有正確行為。

重跑（從 repository root，沿用本機 `.env`／環境，不要用 production URL）：

```sh
node server/scripts/perf-book-search.mjs /tmp/search.json
PERF_CHAPTERS=5000 PERF_BODY_BYTES=102400 PERF_ROUNDS=3 node server/scripts/perf-book-search.mjs /tmp/search-large.json
node server/scripts/perf-toc-version.mjs /tmp/toc.json
node server/scripts/perf-indexes.mjs /tmp/indexes.json
node server/scripts/perf-export.mjs /tmp/export.json
node server/scripts/perf-login-timing.mjs /tmp/login.json
```

## 部署／backfill／rollback

1. 先部署 migration 0014、0015，再 rollout 應用；新 reader SQL 需要 toc_version 欄位。兩個 migration 已在本機實際執行。
2. API 啟用 TRUST_PROXY 前，先套用 06-network-policy。確認 Traefik 在 kube-system 且 label 是 app.kubernetes.io/name=traefik，並確認 K3s/CNI 會執行 NetworkPolicy。
3. 確認 Traefik entrypoint 的 forwardedHeaders.insecure=false，只信任明確上游 CIDR；若有 CDN，必須先配置該信任鏈，不能全信任 XFF。參考 [Traefik forwarded headers](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/) 與 [預設 proxy headers](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/headers/)。nginx 信任其獲准的 ingress peer，由 NetworkPolicy 限制該 peer；不能把這份 nginx 設定裸露到網際網路。
4. 新 canonical TXT objects 自動建立 `.sidx`，舊物件首次搜尋時補建；可在掛載同一 STORAGE_ROOT 的 worker 環境執行 `node server/scripts/backfill-search-index.mjs`，一次一個物件。sidecar 不在公開路徑、沒有 canonical key／DB 授權捷徑。圖片不建立文字索引。
5. 搜尋索引失效／飽和／短詞會保守 fallback，仍可能掃完整本。若 production 對這些 query 有嚴格延遲要求，需另評估短詞 inverted index；不靠截斷內容換取速度。
6. 更新後執行 `BASE_URL=https://book.7182818.xyz pnpm ops:check-web`。CI release 已檢查 HTML CSP／nosniff／no-cache，完整 smoke script 可另執行。

Rollback：先 rollback API/web image；toc_version 與 triggers 可保留，不影響舊程式。若要移除，停用新 API 後 drop 三個 chapters_toc_* triggers、app.bump_toc_generation()，最後 drop works.toc_version。索引 rollback SQL 為：

```sql
CREATE INDEX chapters_work_position_idx ON app.chapters(work_id, editorial_position);
CREATE INDEX user_follows_user_idx ON app.user_follows(user_id);
```

大表可在獨立非 transaction 操作使用 `CREATE INDEX CONCURRENTLY`；不要 drop unique constraint 或 PK。重新部署先前 migration 要按 repository 的 migration 紀錄處理，不直接竄改 production journal。

移除 sidecars 可在 worker 執行 `node server/scripts/backfill-search-index.mjs --remove`；停止新索引程式後才清理，否則首次搜尋會重新建立。舊版本 storage.list 忽略 `.sidx`；canonical 正文與圖片不變。

## 未執行的現場驗收

沒有連 production、套用 production manifests、檢查真實 Traefik/CNI、觀察 production idx_scan、做 rollout smoke、舊 asset 跨部署保留驗證或實體 iOS/Android L3。以上不能由本機測試冒認完成。缺失 hashed assets 會回 404；新 header 不會自動保存舊部署檔案，仍需按部署策略保留舊 assets 或讓使用者重新載入。

## 最終驗證補記（2026-10-20）

- 完整 Chromium 瀏覽器 suite：38/38 通過。
- 真 nginx built app、enforce CSP 的 reader/history/search/TOC/admin-import 流程：9/9 通過。
- nginx → Hono 限流 fixture：兩個模擬可信 ingress 地址獨立限流；同地址換偽造 XFF 仍被 429；缺真實 IP 時回到同 peer bucket。這不取代 Traefik 清理及 production CNI 的現場驗收。
- 新增搜尋 title-only 候選、export 413/429、EPUB chunk Unicode／段落完整性測試後，單元測試共 171 通過。
- 最終搜尋導航明確關閉面板，目標段落可直接閱讀；跨章載入時不承諾保留搜尋 query。

最後補強搜尋面板關閉、back 非章首還原及「導航失敗重試原目標」後，reader/history/search 子集再次 14/14 通過；lint/typecheck/build 重新檢查。


## 整合遠端 main 後驗證（2026-10-20）

已整合 `87137f3` 的 i18n、SEO 路由、管理員刪除功能及既有 0012／0013 migrations；本批 migrations 順延為 0014／0015。UUID 舊連結與 SEO public-id 地址共用閱讀器生命週期，canonical URL 改寫保留 history entry 的閱讀位置，兩種路由均驗證 back/forward、hash 及失敗重試。

- `pnpm lint`、`pnpm typecheck`、`pnpm build` 通過。
- 全部單元測試 211/211（m0 10、web 64、server 137）通過。
- 獨立、全新 PostgreSQL 18：完整 migration chain、角色 grants、`db:verify` 通過；`db:generate` 確認沒有 schema 差異。原有本機開發資料庫未改動。
- 真 nginx 1.28 + built app：headers/cache/gzip/proxy smoke 通過；enforce CSP 瀏覽器 reader/history/search/TOC/admin-import 子集 10/10 通過。
- 整合後完整 Chromium suite：42/42 通過，包含 SEO alias／舊 UUID 的 history regression、i18n 與管理員刪除流程。
- 完整伺服器整合 suite：106/106 通過。使用預設註冊政策（不設定 REGISTRATION_MODE），並以 `node --test --test-force-exit --test-concurrency=1 test/*.test.ts` 執行，省去測試完成後閒置 pool 的關閉等待。
- 修正遠端 SEO 測試兩個預期：generated column 寫入以 SQLSTATE 428C9 判定；章節 sitemap 以 release snapshot 的 label 與 title 組成預期 canonical URL，避免漏掉 fixture 的章節標題。SEO 功能本身無需修改。
