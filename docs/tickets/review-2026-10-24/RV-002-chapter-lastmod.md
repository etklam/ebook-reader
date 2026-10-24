# RV-002｜章節 sitemap lastmod 改用章節自身的時間

- 嚴重度：中高
- 優先級：P2
- 工作量：中
- 類型：AFK
- 狀態：implemented-local（2026-10-24）

## 要做的事

`sitemap-chapters-N.xml` 每條 URL 的 `<lastmod>` 目前取所屬 release 的 `published_at`。連載新增一章會令全書所有章節 URL 的 lastmod 一併跳新，crawler 因此重爬整本。本票要令 lastmod 反映該章真正的改動時間。

## 分析

`server/src/routes/sitemap.ts:167-190` 的 query 取 `r.published_at`（`r` 為 active `work_releases`），`:189` 再把它套到每一條 chapter URL。

關鍵在 publish 的語義。`server/src/publish/publish.ts:213-245` 每次 publish 都會：

1. `insert into work_releases`，`published_at` 為 `defaultNow()`（`server/src/db/schema.ts:363`，`notNull`，因此不存在 null 導致 1970 或 `RangeError` 的情況）；
2. 重新 snapshot **全部** 章節進 `release_items`（`:233-245` 的 BATCH 迴圈走遍 `current`，而非只走 diff）。

所以 active release 是一份整本 snapshot，`published_at` 的語義是「最近一次 publish 的時刻」，與個別章節是否改動完全無關。一本 1000 章的連載新增第 1001 章，sitemap 就會向 crawler 聲明 1001 條 URL 全部是新鮮的。

後果是 crawl budget 浪費，不是正確性問題 —— lastmod 偏新不會令內容收錄錯誤，但對「lastmod 長期失準」的站，搜尋引擎會逐步不再採信該欄位，之後連真正的新章也不會被優先抓取。`sitemap.ts:1-6` 的檔頭註釋本身就是這個論點（「a crawler that learns to distrust the sitemap stops reading it」），本票是把同一個原則補完。

正確數據已經在手，不需要新 migration：

- `publication_events`（`publish.ts:250-257`）已記錄每次 publish 的 `newChapterIds` 與 `updatedChapterIds`，由 `classify()` 算出。
- `release_items.revision_id` 指向具體 revision，而 `chapter_revisions` 有自己的時間戳 —— 「該章內容最後一次真正改變」就是該 revision 的建立時間。

兩個做法：

- **A（建議）**：`lastmod` 取 `release_items.revision_id` 對應 `chapter_revisions` 的建立時間。一個 join，語義最準：章節內容沒變，revision 就是舊的，lastmod 自然不動。需留意 label／title 是 snapshot 進 `release_items`（`publish.ts:239-240`），因此只改標題而 revision 不變時 lastmod 不會動；實務上可接受，crawler 關心的是正文。
- **B**：由 `publication_events` 反推每章最後一次出現在 `newChapterIds ∪ updatedChapterIds` 的 release 時間。語義上最貼近「上次有實質改動」，但需掃 event 歷史，成本高於 A。

另外需明確保留：`:157` 的作品層 lastmod 取 release `published_at` 是**正確**的（作品層面上「最近一次發布」就是它的更新時間），本票不應改動。

## 驗收條件

- [ ] 章節 URL 的 `lastmod` 來自該章 revision 的時間，而非 release 的 `published_at`。
- [ ] 有測試：一本已發布作品只新增一章後重新 publish，舊章節的 `lastmod` 不變、新章節有新 `lastmod`。
- [ ] 作品層 sitemap（`sitemap-works-N.xml`）的 `lastmod` 行為不變，並有測試 pin 住。
- [ ] 新 query 的成本有量測（一頁 `PAGE_SIZE = 10_000`），結果記入 `docs/perf/`；不得令 sitemap 頁退化成全表掃描。
- [ ] `pnpm test` 與 `pnpm --filter server test:e2e` 通過。

## 不在範圍

改動 publish 的 snapshot 策略（整本 snapshot 是 release 不可變性的基礎，不應為 sitemap 而改）、為 sitemap 加 `changefreq`／`priority`（兩者 Google 已明言忽略）。

## 依賴

無。

## 實作結果（2026-10-24）

採用方案 A。`sitemap-chapters-N.xml` 的 query 加 `join app.chapter_revisions cr on cr.id = ri.revision_id`，`lastmod` 改取 `cr.created_at`。`release_items.revision_id` 是 `notNull` FK，所以 join 不會丟行；`chapter_revisions` 既有 `(chapter_id, created_at)` 索引，而本 query 是以主鍵 join，不需要新索引。

作品層 `lastmod`（`:157`）維持 release `published_at`，並在註釋寫明這是刻意的。

新增單元測試 `chapter lastmod tracks the revision, not the release`，同時 assert release 時間不會洩漏進輸出。

**未完成：** 「已發布作品只加一章後重新 publish，舊章節 lastmod 不變」這個驗收條件需要真實資料庫，屬 `pnpm --filter server test:e2e` 範圍，未執行。query 成本未量測（未寫入 `docs/perf/`）—— 改動只是多一個主鍵 join，但未量測就是未量測。

## 審查依據

- `server/src/routes/sitemap.ts:1-6`、`:157`、`:164-190`
- `server/src/publish/publish.ts:207-245`、`:250-257`
- `server/src/db/schema.ts:363`
