# 書架、發現與讀者回報

2026-10-13 使用者確認新增六項：書架分組／閱讀狀態、書內搜尋、錯字回報、排行榜篩選、相似作品、下一章預載。2026-10-15 後續完成目錄定位／搜尋、書籤備註、書庫排除條件、朗讀位置與匯入比對等 AFK tickets，見[工作索引](tickets/reader-improvements/README.md)。

## 使用入口與行為

- 我的書庫 →「整理」：手動設定想讀／閱讀中／已讀／擱置，以及自訂分組（最多 40 字）。新收藏預設想讀；不由閱讀進度推斷已讀。閱讀狀態與分組篩選作用於整個書架，游標綁定帳號及條件。重複收藏保留原設定與加入日期；移除後復原會恢復設定。
- 閱讀器 → 目錄 →「搜尋本書」：查目前可閱讀版本，每章顯示第一個匹配段落，支援繁簡字互查；每頁最多 50 個章節，以游標翻頁，連結帶章節／段落／修訂位置。查詢最多 100 字；每來源地址每分鐘 10 次。找到本頁及 lookahead 命中後提早停止，不計算整本精確總數；無命中仍需掃描剩餘正文。發布／草稿版本變更會要求重新搜尋。[量測與限制](perf/reader-improvements-2026-10-15.md)。
- 閱讀器 → 設定 →「回報錯字」：可先選取正文，再開啟回報；未選取時以目前閱讀段落為起點。表單可調整段落號碼、核對原文後提交最多 1,000 字說明。需登入，每帳號每小時 20 次；伺服器驗證目前發布版本，保存原文摘錄（最多 1,000 字），不信任客戶端摘錄。
- 管理後台 → 錯字回報：分待處理／已處理，可定位到章節編輯並選取對應段落。回報保留舊修訂摘錄；編輯的是目前草稿，必須核對位置。標記已處理與修改、發布正文為分開操作。
- 排行榜：收藏／點擊 × 周／月／年／總，新增連載狀態與分類篩選；條件保存於網址，切換榜單不會清除。詳細計數語義見 [排行榜](rankings.md)。
- 作品詳情 → 相似作品：只列有共同有效標籤或分類的公開且已發布作品，最多 6 部；按共同標籤數、共同分類數、書名及 ID 排序，不補入無關作品。
- 下一章預載：捲動達 80% 或分頁進入最後兩頁才觸發，短章可立即預載；回錨完成前不預載，設定重排不反覆重抓。切章先以小型作品 metadata 請求重新確認權限及發布版本，再重用仍有效的正文；版本改變則重抓。只在本次閱讀器實例保留，30 秒到期，失敗可正常切章重試；隱藏／離開清除快取，草稿不預載，不提前記已讀。
- 閱讀器 → 目錄：初次顯示目前章節附近 100 筆，支援前後載入、定位目前／最新章、搜尋章名／原始章號與正反閱讀順序；不載入正文，版本失效有重新載入入口。
- 閱讀器 → 書籤：一鍵建立後可填寫或略過備註。我的書籤可修改／清空 500 字內備註，按作品篩選並分頁；作品選項涵蓋本人全部書籤。刪除復原保留原錨點與備註。
- 書庫篩選：標籤按鈕依序切換未選／包含／排除，顯示明確文字；包含保持全部／任一規則，命中任何排除標籤即排除。同一標籤不會兩邊同時存在。會員可啟用「隱藏已讀」，只依本人書架手動的已讀狀態判斷，條件保存於網址，私人結果與游標綁定帳號。
- 閱讀器 → 語音朗讀：可朗讀本章、從目前 canonical 段落開始，或在同一會話停止後從該段續播；目前段落有不改變排版的提示，不強制捲動。跳過圖片 marker，保留原段落索引。背景／鎖屏行為仍由裝置與瀏覽器決定，未完成真機驗證。
- 管理後台 → 匯入比對：逐章分類、有界清單及按需正文核對；決策沿用既有人工對應／排除／新章契約。套用前必須取得精確方案並核對，重試沿用同一冪等識別，編輯或分析版本改變要求重新比對；人工目標不可重複，資源差異也算修訂，套用後仍需另行發布。

## 資料庫與 API

新增 migration `0011_silent_phalanx.sql`：`user_library.reading_status/group_name`、`content_reports`。部署時執行 `pnpm db:migrate`；本機已套用。

- `GET /api/me/library?readingStatus=want|reading|finished|paused&groupName=...`：省略分組為全部，空字串為未分組，回傳全書架的分組選項。
- `PATCH /api/me/library/:workId`：更新自己的收藏狀態／分組。
- `GET /api/reader/works/:id/search?q=...&cursor=...`：每頁最多 50 筆，回傳 `total: null`、已顯示 `offset`、`nextCursor`、`hasMore`。首請求不帶游標，舊 `offset=0` 可省略；非零 offset 回 `cursor_required`。游標失效回 `search_version_changed`（409），前端重新搜尋。
- `GET /api/reader/works/:id/chapters`：原 `limit/offset` 保留，新增 `aroundChapterId`、`latest=true`、`q`、`order=asc|desc`、`version`；回傳 `version/previousOffset/nextOffset/anchorMissing`。章號按閱讀順序，不轉數字；版本失效回 `toc_version_changed`（409）。
- `GET /api/me/bookmarks?workId=...&offset=...&limit=...`：回傳本人作品選項、總數、分頁與書籤；`PATCH /api/me/bookmarks/:id` 以 `note` 修改備註，POST/PATCH 超過 500 字回 `invalid_note`。
- `GET /api/works` 與 `/api/works/count`：新增 `excludeTagIds`、`hideFinished=true|false`，共用條件。私有篩選需要有效會員登入，游標綁定本人；結果使用 `private, no-store`，依 Cookie 區分。標籤有效性沿用既有規則，未新增任意數量上限。
- `GET /api/admin/imports/:id/review`：40 項一頁的分類清單；`/review/targets` 查可人工對應目標；`/review/detail` 載入一對正文的有界片段；`POST /review-plan` 驗證並回傳精確方案但不寫入。新版 apply 提交 `analysisVersion`，與既有 `baseEditVersion`、`resolutions`、`Idempotency-Key` 一起驗證；未帶新分析 token 的既有呼叫保留原冪等 hash。
- `POST /api/me/content-reports`：`workId/chapterId/revisionId/paragraphIndex/message`。
- `GET /api/admin/content-reports?status=open|resolved&offset=0`、`PATCH /api/admin/content-reports/:id`（`status: resolved`）。
- `GET /api/works/:id/related`：相似作品。
- `GET /api/rankings`：額外接受 `serialStatus`、`categoryId`。

新增驗證：server 的 library、search-export、content-reports 單元測試，以及 e2e-discovery-features／e2e-reader-features PostgreSQL 整合測試；web 的 discovery-features、content-reports、search-features、rankings 瀏覽器測試（模擬 API）。這些不能取代真機 L3。

2026-10-13 驗證：型別檢查、lint、前端 build、125 項單元測試、81 項 PostgreSQL 整合回歸、10 項 Chromium 瀏覽器測試，以及 db:verify 全部通過。手機（390px）與桌面（1280px）介面截圖已檢查；當時真機 L3 與大型作品搜尋壓測尚未執行。

2026-10-15 後續驗證與剩餘真機限制見 [AFK 執行紀錄](tickets/reader-improvements/verification.md)，本機正文搜尋與捲動／預載量測見 [效能比較](perf/reader-improvements-2026-10-15.md)。
