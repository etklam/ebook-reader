# RV-012｜詳細閱讀時間與數據統計

- 嚴重度：不適用（功能需求）
- 優先級：P2
- 工作量：中至大
- 類型：HITL（需決定時間歸屬的粒度與保留期）
- 狀態：open

## 要做的事

目前的閱讀紀錄頁有總量與一年日曆，但無法回答「我在哪本書上花了多少時間」。本票要把閱讀時間從「每日一個總數」擴充成可按作品、時段與時間範圍拆解的統計。

## 分析

### 現狀

已經有的（不要重做）：

- `app.user_chapter_reads`（`server/drizzle/0004_m6.sql:76-82`）：`(user_id, chapter_id)` 主鍵，附 `first_read_at`／`last_read_at`。即「讀過哪些章、何時第一次／最後一次」是完整的。
- `app.user_reading_activity`（`server/drizzle/0009_reading_stats.sql`）：`(user_id, activity_date)` 主鍵，`active_seconds`，並有 `between 0 and 86400` 的 check。
- `GET /api/me/reading-stats`（`server/src/routes/reading-stats.ts:28`）：總計（讀過作品／章節／累積秒數）、最近 20 部作品、一年逐日資料。
- `apps/web/src/account/ReadingStatsPage.tsx`（242 行）：三格總計、一年熱度日曆（含月份標籤與一週碎片折疊）、最近讀過清單。

### 真正的限制

`user_reading_activity` 只有 `(user_id, activity_date)` 兩個維度。時間**沒有**歸屬到作品或章節，也沒有時段資訊。所以以下問題目前在資料層就答不了，不是前端沒顯示：

- 這本書我讀了多久？
- 我平常幾點在讀？
- 這一章我讀了多久／我的閱讀速度是多少？

而以下問題其實答得了，只是沒做出來（純前端或純 query）：

- 連續閱讀天數（streak）、最長連續 —— 日曆資料已經在手。
- 本週／本月／今年的時間與章數小計、與上一期比較 —— 同上。
- 每部作品讀了多少章、佔總進度多少 —— `user_chapter_reads` 加 `release_items` 的章數即可。

### 需要決策的點（HITL）

擴充時間歸屬會引入隱私與成本的取捨，必須先決定，不能邊做邊定：

1. **粒度。** `(user_id, work_id, activity_date)` 足以回答「每本書每日多久」，列數約為「使用者 × 同日在讀的書數」，成長可控。再細到 `chapter_id` 可以算閱讀速度，但列數變成「使用者 × 章」，對長篇連載會顯著膨脹。
2. **時段。** 要回答「我幾點在讀」就要存小時桶（例如 `(user_id, activity_date, hour)`）。注意這會把使用者的作息記錄下來，比現有的日粒度敏感得多，而且時區要明確（存 UTC 小時還是使用者本地小時）。
3. **保留期。** 現在沒有任何清理。細粒度資料應該有保留期與彙總策略（例如逐日明細保留 1 年，之後只留月彙總），否則這張表會無限成長。
4. **閱讀速度是否要做。** 需要章節字數。正文在 storage，不在資料庫；要算速度就要在發布時把字數寫進 `release_items` 或 `chapter_revisions`。這是獨立的一塊工作。

建議的最小有用組合：粒度取 `(user_id, work_id, activity_date)`，不做小時桶與閱讀速度，明訂保留期。這能解鎖「每本書花了多少時間」這個最常被問的問題，而不碰作息資料。

### 實作注意

- 現有的 `active_seconds` 上報路徑必須找出來並一併改（目前只寫日總數）；前景計時的定義（什麼算「在讀」）不要在本票改變，否則新舊數據不可比。
- `reading-stats.ts:30` 的 `visible` 條件（排除 `removed`、非 admin 排除 `draft`）必須套用到所有新的拆解維度，否則已刪除作品會從統計洩漏回來。這點與 RV-010 相關：作品被刪除後，它在個人統計中應該如何呈現，要明確決定。
- 回填：既有的日總數無法事後歸屬到作品。新維度只能從上線之日起累積，UI 必須誠實標示，不要讓舊資料看起來像「這本書 0 小時」。

## 驗收條件

- [ ] 粒度、時段、保留期、閱讀速度四項決策已記錄在票內，未採用的明確寫為不做。
- [ ] 時間可按作品拆解；統計頁顯示每部作品的累積閱讀時間與章數。
- [ ] 週／月／年區間的時間與章數小計，以及與上一期的比較。
- [ ] 連續閱讀天數與最長連續（由現有日曆資料計算，不需新表）。
- [ ] 所有新 query 套用與 `reading-stats.ts:30` 相同的可見性條件，並有測試證明 `removed`／`draft` 作品不洩漏。
- [ ] 新增的明細表有保留期與彙總策略，並有可重跑的維護指令。
- [ ] 上線前的歷史資料在 UI 明確標示為「無法歸屬」，不偽裝成零。
- [ ] 新 query 的成本有量測並記入 `docs/perf/`。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm --filter server test:e2e`、`pnpm db:verify` 通過。

## 不在範圍

閱讀速度與字數統計（需先在發布時記錄章節字數，另開票）、小時級作息資料（除非決策明確採用）、跨使用者的排行或比較、資料匯出。

## 依賴

與 RV-010 相關：已刪除作品在個人統計中的呈現需要一致的決定。

## 審查依據

- `server/drizzle/0004_m6.sql:76-82`、`server/drizzle/0009_reading_stats.sql`
- `server/src/routes/reading-stats.ts:28-60`
- `apps/web/src/account/ReadingStatsPage.tsx`
