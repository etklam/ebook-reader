# Ebook／小說閱讀平台（暫稱）

管理員維護內容的中文小說閱讀網站。需求與工程基線見 [`dev-plan.md`](dev-plan.md)（規格版本 v1.3，2026-09-28）——那是唯一規格真相，實作前先讀它。

目前進度：M0（規格及高風險 POC）程式完成——閱讀引擎擇一已由 [ADR-07](docs/adr/adr-07-reader-architecture.md) 取代（生產採 canonical renderer，不整合 epub.js／foliate-js），真機驗證轉移至 M5 L3 清單；M1（基礎工程）完成，gate 已過（DB-01／02／03、非 Admin 403、本機可啟動、CI L1＋L2）；**M2（首次匯入）完成**——上傳→佇列→編碼偵測（TXT）／spine 解析（EPUB）→分章→staging→Admin 預覽→commit 為草稿。M2 gate（IMP-01、05、12、14–16）以真 PG e2e 驗收：base-180 建 180 章 180 修訂、commit 冪等、失敗回滾、EPUB 按 spine 順序（非檔名順序）、zip bomb／惡意 XHTML 防護。**M3（增量與中間插章）完成**——匹配引擎＋`GET /api/admin/imports/:id/diff`＋`POST /:id/apply`（`baseEditVersion` 樂觀鎖、錨點插入、modified 保留站方、無錨點需 `confirmAppend`、ambiguous/structural 需 `resolutions`）。Gate（IMP-02、04–08、18）unit 10/10＋e2e 13/13。**M4（覆蓋與可靠套用）完成**——`mode: overwrite` 建新不可變修訂（chapter_id 不變）、`Idempotency-Key` 冪等、受保護回復（`revert-plan`/`revert`，後續修改擋回復）。Gate（IMP-03、09–13、VER-01/02）e2e 17/17（serial 執行，連跑穩定）。work_release 發布快照併入 M6；IMP-17 資源感知部分延後（ADR-08）。**M6（發布＋公開書庫＋會員）實作完成**——發布快照（`work_releases`/`release_items`，`POST /api/admin/works/:workId/publish` 冪等，編輯 head 與公開 release 分離：匯入/覆蓋不影響公開內容直到明確發布）、出版事件（新章≠修訂，PUB-01/02 過）、公開書庫（搜尋含繁簡、分類 OR、標籤 all/any、連載狀態、分頁；CAT 過）、taxonomy 管理、邀請制註冊、書庫/追更/進度（樂觀並發）/已讀/書籤/偏好同步、閱讀器會員端同步（訪客本機保留）；e2e 42/42（PUB/CAT/READ-03/權限矩陣）＋瀏覽器 12/12。**M5（手機閱讀器）實作完成、L3 真機待驗**——reader API（work／TOC／head-revision chapter，e2e 6/6）＋canonical renderer 手機閱讀器（捲動／分頁、段落錨定回錨、繁簡檢視期轉換、三主題、字號行距段距、bottom sheet、本地設定與位置），瀏覽器驗收 6/6（390×844）；真機 L3 清單見 [`docs/adr/l3-device-checklist.md`](docs/adr/l3-device-checklist.md)，**實機未執行，不得宣稱完全驗收**。

2026-10-13 新增書架分組與閱讀狀態、書內搜尋分頁、章節錯字回報、排行榜篩選、相似作品及下一章預載；入口、API 與 migration 見 [功能說明](docs/reader-discovery-features.md)。

## 本機啟動（M1+M2）

```bash
pnpm install
pnpm db:up          # docker compose 起 PostgreSQL 18（首次會建低權限 roles）
pnpm db:migrate     # migration + grants（跑兩次無害）
pnpm --filter server exec node --env-file=.env scripts/create-admin.mjs <email> <password>
pnpm dev:api        # :3000，/readyz 檢查 DB
pnpm dev:worker     # 匯入 worker（PG-backed queue，輪詢處理 import jobs）
pnpm dev:web        # :5173（M2 Admin 匯入 ＋ M5 閱讀器：/read/:workId/:chapterId）
pnpm lint           # eslint（L1）
pnpm test           # 單元測試（L1：章號解析、分章、編碼偵測、reader 段落/設定/轉換）
pnpm db:verify      # DB-01/02/03 + M2 約束驗收腳本
pnpm --filter server test:e2e   # M2–M4＋M5 reader API L2 驗收（需 DB 已起）
pnpm --filter web test:browser  # M5＋M6 瀏覽器驗收（需 api+worker+web 已起；Playwright ≠ 真機 L3）
```

公開 API：`GET /api/works`（書庫＋篩選）、`GET /api/works/count`、`GET /api/works/:id`、`GET /api/taxonomy/:kind`；會員 API：`/api/me/library`、`/api/me/follows`（+`/seen`）、`/api/me/progress/:workId`（`baseVersion` 樂觀鎖）、`/api/me/reads`、`/api/me/bookmarks`、`/api/me/reader-preferences`；註冊 `POST /api/auth/register`（`REGISTRATION_MODE=closed|invite|open`，預設 closed）。

M2 匯入 API（全部 Admin-only）：`POST /api/admin/imports`（上傳 TXT/EPUB，限 30/50 MiB）、`GET /api/admin/imports/:id`（狀態＋編碼結果＋章數）、`GET /api/admin/imports/:id/chapters`（分頁 staged 章節）、`POST /api/admin/imports/:id/commit`（冪等首匯入提交）、`POST /api/admin/imports/:id/reanalyze`（指定編碼重解析）。

## M7 Beta hardening（程式與文件完成；真機 L3 待執行）

**Beta 之前剩下的唯一工作是真機驗證**（`docs/adr/l3-device-checklist.md` 18 項，需實機執行）。其餘 M7 工作已全部落地，分五批 commit：

- **安全與正確性回歸**（HRD-01–08）：`/api/works/count` 原本忽略所有 filter，現與 list 共用同一 predicate builder；進度／書籤拒絕跨作品章節引用；非法 `workId` filter 回 400 而非靜默回傳全部；`follows/seen` clamp；非 UUID path param 回 4xx 而非 500（並停止把 SQL 與參數印進 log）；`requireAdmin` 移至父 app（不再依賴 route 註冊順序）；login 加 per-IP＋per-account 限流；全域 JSON body 上限與安全標頭。
- **Cursor 分頁**（PAG-01–07，CAT-03）：offset 分頁在捲動途中有新發布會靜默漏書，改為綁定 filters＋sort 的 opaque cursor；`/api/me/library` 同步改為 keyset（原本無上限回傳整個書架）。
- **帳號自助**（ACC-01–06）：改密碼、session 列表／撤銷、Admin 代發一次性密碼復原 token。原本洩漏的 cookie 只能等 30 天 TTL。
- **資源層**（RES-01–08，ADR-08／IMP-17）：EPUB 圖片與註腳不再被丟棄；canonical body 以 `[[img:<hash>]]` marker 表示，非 marker 段落逐字不變；資源以 content hash 定址、與不可變修訂一起凍結；`/api/reader/resources/:hash` 以可達性授權。**SVG 拒收**，註腳**非互動式**。
- **可運維性**：`pnpm backup`／`restore:verify`（**還原演練已實際執行通過 8/8**，含真的用 API 讀出一章）、`pnpm maintenance`（session／孤立檔回收，storage 預設 dry-run）、`pnpm ops:check`、結構化 JSON 請求日誌、`pnpm perf:seed`／`perf:measure`、瀏覽器測試入 CI。

**限流是單 process 的，不是分散式限流，也不是 DDoS 防護**（邊緣／proxy 責任，§16）。
部署與運維請照 **[`docs/beta-runbook.md`](docs/beta-runbook.md)**；正式環境 Forgejo → K3s 部署步驟見 **[`docs/deployment.md`](docs/deployment.md)**；效能基線與索引決策見 [`docs/perf/`](docs/perf/)；後續計劃見 [`docs/development-plan.md`](docs/development-plan.md)。

```bash
pnpm dev:lan          # vite --host，手機可連（跑真機 L3 用）
pnpm seed:l3          # 建三部已發布樣本，覆蓋 18 項檢核所需素材
pnpm ops:check        # 健康檢查（exit 0/1/2，給 cron）
pnpm backup           # DB＋storage＋manifest
pnpm maintenance      # 回收（storage 預設 dry-run）
```

未做：真機 L3（18 項）、併發壓測、互動式註腳、SVG、taxonomy 合併／alias、回復補償自動化、`open` 註冊（需 email 驗證）。

開發順序 M0→M7 與各階段 gate 見 dev-plan §22；驗收分層見 §22A（CI 跑 L1+L2，真機僅 M0/M5/M7）；實際進度以 dev-plan §26 為準。
