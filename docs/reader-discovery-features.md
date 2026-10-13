# 書架、發現與讀者回報

2026-10-13 使用者確認新增六項：書架分組／閱讀狀態、書內搜尋、錯字回報、排行榜篩選、相似作品、下一章預載。

## 使用入口與行為

- 我的書庫 →「整理」：手動設定想讀／閱讀中／已讀／擱置，以及自訂分組（最多 40 字）。新收藏預設想讀；不由閱讀進度推斷已讀。閱讀狀態與分組篩選作用於整個書架，游標綁定帳號及條件。重複收藏保留原設定與加入日期；移除後復原會恢復設定。
- 閱讀器 → 目錄 →「搜尋本書」：查目前可閱讀版本，每章顯示第一個匹配段落，支援繁簡字互查；每頁 50 個章節，可翻頁，連結帶章節／段落／修訂位置。查詢最多 100 字；每來源地址每分鐘 10 次。搜尋逐章讀取正文，大型作品仍需效能量測後決定是否建立索引。
- 閱讀器 → 設定 →「回報錯字」：可先選取正文，再開啟回報；未選取時以目前閱讀段落為起點。表單可調整段落號碼、核對原文後提交最多 1,000 字說明。需登入，每帳號每小時 20 次；伺服器驗證目前發布版本，保存原文摘錄（最多 1,000 字），不信任客戶端摘錄。
- 管理後台 → 錯字回報：分待處理／已處理，可定位到章節編輯並選取對應段落。回報保留舊修訂摘錄；編輯的是目前草稿，必須核對位置。標記已處理與修改、發布正文為分開操作。
- 排行榜：收藏／點擊 × 周／月／年／總，新增連載狀態與分類篩選；條件保存於網址，切換榜單不會清除。詳細計數語義見 [排行榜](rankings.md)。
- 作品詳情 → 相似作品：只列有共同有效標籤或分類的公開且已發布作品，最多 6 部；按共同標籤數、共同分類數、書名及 ID 排序，不補入無關作品。
- 下一章預載：章節成功開啟後預載下一章；切章消耗相同請求，不重抓、不提前記已讀。只在本次閱讀器實例保留，30 秒到期，失敗時正常切章可重試；重訪章節重新取得目前版本。

## 資料庫與 API

新增 migration `0011_silent_phalanx.sql`：`user_library.reading_status/group_name`、`content_reports`。部署時執行 `pnpm db:migrate`；本機已套用。

- `GET /api/me/library?readingStatus=want|reading|finished|paused&groupName=...`：省略分組為全部，空字串為未分組，回傳全書架的分組選項。
- `PATCH /api/me/library/:workId`：更新自己的收藏狀態／分組。
- `GET /api/reader/works/:id/search?q=...&offset=0`：每頁 50 筆，回傳 `nextOffset`。
- `POST /api/me/content-reports`：`workId/chapterId/revisionId/paragraphIndex/message`。
- `GET /api/admin/content-reports?status=open|resolved&offset=0`、`PATCH /api/admin/content-reports/:id`（`status: resolved`）。
- `GET /api/works/:id/related`：相似作品。
- `GET /api/rankings`：額外接受 `serialStatus`、`categoryId`。

新增驗證：server 的 library、search-export、content-reports 單元測試，以及 e2e-discovery-features／e2e-reader-features PostgreSQL 整合測試；web 的 discovery-features、content-reports、search-features、rankings 瀏覽器測試（模擬 API）。這些不能取代真機 L3。

本次驗證：型別檢查、lint、前端 build、125 項單元測試、81 項 PostgreSQL 整合回歸、10 項 Chromium 瀏覽器測試，以及 db:verify 全部通過。手機（390px）與桌面（1280px）介面截圖已檢查；真機 L3 與大型作品搜尋壓測仍未執行。
