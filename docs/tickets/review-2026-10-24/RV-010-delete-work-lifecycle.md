# RV-010｜刪除作品：可發現性、復原與永久清除

- 嚴重度：中高
- 優先級：P2
- 工作量：中
- 類型：HITL（需決定是否提供永久清除）
- 狀態：implemented-local（2026-10-24，A+B；永久清除未做）

## 要做的事

刪除作品的能力其實已經存在，但入口藏在「草稿與發布」面板內，而且刪除是終局的 —— 沒有復原路徑，也沒有任何方式回收磁碟。本票要令刪除成為一個完整的生命週期。

## 分析

### 現狀（與「沒有刪除功能」的認知不符，先說清楚）

端到端是通的：

- API：`server/src/routes/admin-works.ts:46-57`，`DELETE /api/admin/works/:workId`，把 `visibility` 設為 `'removed'`、`editVersion + 1`。註釋說明它刻意鎖同一行以免與 publish 競爭。
- UI：`apps/web/src/admin/PublishPanel.tsx:107-120` 的 `removeWork()`，按鈕在 `:158`。
- 測試：`server/src/routes/admin-delete.test.ts` 與 `apps/web/e2e/admin-delete.spec.ts` 都有覆蓋，e2e 用的 fixture 帶 `activeReleaseId: 'release'`，即已發布作品也可刪。

所以不是「沒有功能」，而是**找不到**。三個原因：

1. 入口在 `tab === 'publish'`（「草稿與發布」）之下，必須先在該面板的下拉選單揀一本作品，按鈕才會出現（`:158` 的條件是 `draft &&`，而 `draft` 要等 `/api/admin/preview/works/:id/chapters` 回來）。一個想刪書的人不會先想到去「發布」頁。
2. 按鈕樣式是 `className="btn"`，與旁邊的「重新載入」完全相同，沒有破壞性操作的視覺區分。
3. 作品頁、catalog、匯入面板都沒有任何刪除入口。

### 真正的缺口：刪除是單向的

`'removed'` 是軟刪除，但沒有任何路徑回來：

- `admin-works.ts:38` 的管理清單 `where` 包含 `${works.visibility} <> 'removed'`，所以已刪除作品不再出現在 UI 的下拉選單，無法再被選中。
- `PATCH /api/admin/works/:workId`（`:59-81`）不碰 `visibility`，所以沒有 API 可以改回來。
- `publish.ts:95` 的 `publishPreview` 對 `removed` 直接回 `work_removed` 問題，所以也不能靠重新發布救回。

結論：誤刪之後，UI 與 API 都沒有任何復原手段，只能直接改資料庫。而 `removeWork()` 的確認對話框（`PublishPanel.tsx:109`）寫的是「系統會保留內容及閱讀紀錄」—— 技術上正確（資料都在），但讀起來像是可逆的，實際上不是。

### 第二個缺口：刪除永不回收空間

`'removed'` 之後，所有 `chapters`、`chapter_revisions`、`release_items`、`work_releases` 列與 storage 內的正文、圖片、`.sidx` sidecar 全部保留。M7 的 orphan sweep（`server/src/storage.ts:22-26` 的 `modifiedAt` 註釋）只清理**沒有任何列引用**的物件，而這些列都還在、都還引用着。所以「刪除一本書」永遠不會釋放一個 byte。對一個以匯入長篇為主的站，這是會累積的。

### 做法

三部分，可分開交付：

- **A（可發現性，小）**：在作品管理清單提供每行的刪除動作，按鈕用破壞性樣式；保留 PublishPanel 的入口。確認文案改為明確說出可否復原。
- **B（復原，中）**：管理清單加「顯示已刪除」篩選，與一個把 `visibility` 從 `'removed'` 改回 `'draft'` 的 API。改回 `'draft'`（而非原本的 `public`）是刻意的：復原後必須重新發布才會再次對讀者可見，不會因為一次誤操作把作品直接推回公開。
- **C（永久清除，需決策）**：真正的硬刪除。需要人工決定的點：是否允許、誰可以執行、是否需要二次確認或冷卻期、閱讀紀錄（`library`、`bookmarks`、`reading_progress`）如何處理。`me.ts:88` 目前對 `removed` 作品回 `null`，所以會員資料仍指向已刪除作品 —— 硬刪除必須決定是連帶清除還是保留孤兒列。建議本票只做 A + B，C 以獨立票處理並明確記錄待決問題。

## 驗收條件

- [ ] 作品管理清單每行有刪除入口，使用破壞性視覺樣式，與「重新載入」等非破壞性動作明顯區分。
- [ ] 確認對話框準確描述後果，包括是否可復原。
- [ ] 管理清單可切換顯示已刪除作品；已刪除作品清楚標示狀態。
- [ ] 有 API 可將已刪除作品復原為 `draft`；復原後必須重新發布才對讀者可見，並有測試。
- [ ] 復原路徑有並發保護：與 publish 競爭時行為明確（沿用 `admin-works.ts:49-52` 的行鎖手法）。
- [ ] 公開面測試確認：`removed` 期間讀者無法開啟、不出現在 catalog／sitemap／排行榜；復原為 `draft` 後仍然不可見。
- [ ] 永久清除的待決問題已記錄成獨立票，不留在本票驗收條件內。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm --filter server test:e2e`、`pnpm --filter web test:browser` 通過。

## 不在範圍

硬刪除與空間回收（方案 C，獨立票）、會員資料的連帶清除、刪除的審計日誌。

## 依賴

無。

## 實作結果（2026-10-24）

做了 A（部分）與 B；C（永久清除）未做。

**B（復原）—— 本票的真正缺口。** 新增 `POST /api/admin/works/:workId/restore`，把 `visibility` 從 `removed` 改回 **`draft`**，不是改回原本的可見性：誤刪的復原不應該把書直接推回讀者面前，重新發布是另一個刻意的動作（而 `publish.ts` 會把 draft 升為 public，所以路徑是通的）。UPDATE 的 WHERE 同時鎖 `id` 與 `visibility = 'removed'`，沿用 delete 與 publish 的同一套行鎖手法；UPDATE 沒命中時再查一次，區分「從未刪除」（409 `work_not_removed`）與「不存在」（404）。

`GET /api/admin/works?removed=1` 列出**只有**已刪除的作品（而非混進 50 筆現役列中），並把排序由 `createdAt` 改為 `updatedAt` —— 復原時想找的是「剛剛刪錯那本」。PublishPanel 加「顯示已刪除作品（可復原）」勾選，選中一部即確認後復原。

**A（可發現性）—— 部分。** 刪除按鈕改用新的 `.btn.danger`（外框式紅色，不與 `.primary` 爭視覺重量，顏色也不是唯一訊號）。確認文案改寫：舊版「系統會保留內容及閱讀紀錄」technically 正確但讀起來像可逆，而當時並不可逆；現在可逆了，文案直接說明在哪裡復原。

**未完成：**
- 作品管理清單每行的刪除入口（現時入口仍只在「草稿與發布」面板內，只是視覺上已區分）。
- 公開面的回歸測試：`removed` 期間不出現在 catalog／sitemap／排行榜、復原為 `draft` 後仍不可見 —— 需要資料庫，屬 e2e 範圍。
- C（永久清除與空間回收）未實作，亦未開成獨立票。待決問題（誰可執行、冷卻期、`library`／`bookmarks`／`reading_progress` 如何處理）原文保留在上方「做法」一節。

驗證：`pnpm lint`、`pnpm typecheck`、server 151 項全過（含 4 項新增的 restore 測試）。`apps/web/e2e/admin-delete.spec.ts` 新增復原流程 case，**未執行**。

## 審查依據

- `server/src/routes/admin-works.ts:34-57`、`:59-81`
- `apps/web/src/admin/PublishPanel.tsx:107-120`、`:158`
- `server/src/publish/publish.ts:95`
- `server/src/routes/me.ts:88`
- `server/src/storage.ts:22-26`
- `server/src/routes/admin-delete.test.ts`、`apps/web/e2e/admin-delete.spec.ts`
