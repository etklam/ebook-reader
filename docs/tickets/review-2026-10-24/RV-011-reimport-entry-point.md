# RV-011｜重新匯入：補上可用的入口

- 嚴重度：中高
- 優先級：P2
- 工作量：中
- 類型：AFK
- 狀態：implemented-local（2026-10-24）

## 要做的事

重新匯入（把新來源檔套用到既有作品）的後端與覆核介面都已完整，但唯一的入口是一個要人手貼 UUID 的輸入框，藏在折疊的「進階匯入設定」裡。本票要令這條路徑可用。

## 分析

### 現狀：後端完整，入口不可用

整條管線已經存在，而且做得相當細：

- `POST /api/admin/imports` 接受 `workId` 表單欄位（`server/src/routes/admin-imports.ts:50`，UUID 驗證在 `:75-81` 一帶）。有 `workId` 就進入增量／覆蓋流程，留空則建立新作品。
- 覆核：`GET …/review`、`…/review/targets`、`…/review/detail`（`:234`、`:262`、`:272`）。
- 預演與套用：`POST …/review-plan`（`:303`）與 `POST …/apply`（`:313`），帶 `baseEditVersion` 樂觀鎖、`analysisVersion`、人工 `resolutions`、`confirmAppend`、`idempotency-key`。
- 回退：`…/revert-plan`、`…/revert`（`:337`、`:344`）。
- 核心邏輯 `server/src/import/apply-incremental.ts:1-8` 的註釋說明了保守契約：只有有錨點且高信心的 `new` 項目會成為章節，`modified` 保留站方版本，缺失章節保留。
- 前端覆核介面 `apps/web/src/admin/ImportReview.tsx` 已掛在 `AdminApp.tsx:489`，支援未解決項目阻擋套用、`stale` 偵測、冪等重試。ER-010 已交付並驗證。

缺的只有入口。`apps/web/src/admin/AdminApp.tsx:424-430`：

```tsx
<details><summary>{t('進階匯入設定（更新既有作品／指定編碼）')}</summary>
  <label htmlFor="imp-work">{t('目標作品 ID')}</label>
  <input className="input input-mono" id="imp-work" value={workId} placeholder="work UUID" … />
  <span className="hint">{t('留空＝建立新作品。填入才會進入增量／覆蓋流程。')}</span>
```

要重新匯入一本書，管理員必須：知道「重新匯入」藏在「進階匯入設定」之下、展開折疊區、另外設法取得該作品的 UUID、貼進去。UUID 在 UI 裡只有一處會顯示 —— `BatchImportPanel.tsx:359` 的批量匯入結果列。從作品頁、管理清單或發布面板都拿不到。

實務後果：這條路徑等於不存在，而替代做法（重新匯入成一本新作品）會產生重複作品、斷開讀者的進度與書籤、並在 sitemap 產生兩套 URL。

### 做法

- **A（核心）**：把「目標作品 ID」的自由文字輸入換成作品選擇器，重用 `/api/admin/works` 與 `PublishPanel.tsx:38-44`、`:146-153` 已有的搜尋＋下拉模式（含 50 筆上限與關鍵字提示）。
- **B（入口）**：把重新匯入從「進階設定」提升為一個明確選擇：匯入面板頂部二選一 ——「建立新作品」／「更新既有作品」。後者展開作品選擇器。`:343` 的流程提示（「匯入 → 快速確認 → 發布」）需要為更新路徑給出對應的一句（匯入 → 覆核差異 → 套用 → 發布）。
- **C（反向入口）**：在發布面板（已選定作品的情境下）提供「重新匯入此作品」，帶着 `workId` 跳去匯入頁。這是管理員實際的心理路徑：我正在看這本書，我要更新它。

三者都只動前端，沒有新 API。

### 實作時必須確認的既有行為

- `ImportReview.tsx:108` 的套用按鈕條件是 `!busy && loaded && !stale && unresolved === 0 && acknowledged && plan?.payload === payload`。新入口不得繞過任何一項。
- `reanalyzeImport`（`server/src/import/reanalyze.ts:19`）只接受 `['ready','review_required','failed']` 狀態；`applied` 是終局的。UI 在更新路徑下要正確反映這點，不要給出一個會回 409 的按鈕。
- `mode: 'overwrite'` 是破壞性得多的選項（`apply-incremental.ts` 的 `AppliedSnapshot.mode`）。新入口要令兩種 mode 的差異在選擇時就清楚，而不是在套用前一刻。

## 驗收條件

- [ ] 匯入面板以明確的二選一呈現「建立新作品」與「更新既有作品」，後者不再需要人手貼 UUID。
- [ ] 目標作品以搜尋選擇器選定，重用既有 `/api/admin/works` 契約與 50 筆上限行為。
- [ ] 發布面板提供「重新匯入此作品」，帶 `workId` 進入匯入流程。
- [ ] 增量與覆蓋兩種 mode 的差異在選擇目標時已經說明清楚。
- [ ] 既有的套用前置條件（未解決項目、`stale`、`acknowledged`、plan 與 payload 相符）全部維持有效，並有測試證明新入口不能繞過。
- [ ] 一個 e2e spec 走完整路徑：選既有作品 → 上傳 → 覆核 → 預演 → 套用 → 發布。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm --filter web test:browser` 通過。

## 不在範圍

改動 `apply-incremental` 的匹配或合併語義（ER-010 已交付且刻意保守）、自動合併衝突、新增後端端點。

## 依賴

RV-009 相關但非阻塞：章節編號若產生不了 `key`，重新匯入時會按 title／body 證據匹配，容易把整批章節判成新增。先做 RV-009 可令本票的匹配品質明顯較好。

## 實作結果（2026-10-24）

做了 A、B、C，全部純前端，沒有新後端端點。

**A** 新增 `apps/web/src/admin/WorkPicker.tsx`（搜尋 + 下拉，重用 `/api/admin/works` 的 50 筆上限契約），取代原本要人手貼 UUID 的 `目標作品 ID` 輸入框。picker 會為「由其他面板交接過來、但不在當前 50 筆視窗內」的作品保留一個可選項，不會悄悄丟掉。

**B** 匯入表單最上方新增二選一：「建立新作品」／「更新既有作品」。選了更新才顯示 picker；流程提示隨之改為「匯入 → 覆核差異 → 套用 → 發布」；提交按鈕改為「提交並比對差異」，未選作品時 disabled。新作品專屬的 metadata（名稱／作者／簡介／類型／連載狀態／分類標籤）在更新模式下 `hidden` —— 它們只有 commit 會寫入，apply 完全忽略，同時顯示正是兩條流程看起來像同一張表單的原因。

另加一道防護：`submitRequest` 在更新模式下若 `workId` 為空直接報錯返回，不送出。沒有這道防護，一次「更新」會靜默建立一部重複作品 —— 正是這條流程要避免的結果。

**C** PublishPanel 新增「重新匯入此作品」，把 `workId` 交給匯入面板並切換 tab。`ImportPanel` 以 `key` 重掛，確保開始一個乾淨的 job 而不是繼承上一個。

`ImportReview` 完全未改動，所以 `:108` 的套用前置條件（未解決項目、`stale`、`acknowledged`、plan 與 payload 相符）原樣有效。

**未完成：**
- 增量／覆蓋兩種 mode 的差異仍然只在覆核階段呈現，沒有在選擇目標時就說明。驗收條件這一項未達成。
- 沒有一個走完「選既有作品 → 上傳 → 覆核 → 預演 → 套用 → 發布」的單一 e2e spec。已改寫 `import-review.spec.ts` 使用新入口，並在 `admin-delete.spec.ts` 新增交接 case，但兩者**都未執行**。

驗證：`pnpm lint`、`pnpm typecheck`、server 151／web 74 全過。`pnpm --filter web test:browser` 未執行。

## 審查依據

- `apps/web/src/admin/AdminApp.tsx:268-274`、`:342-343`、`:424-438`、`:489`
- `apps/web/src/admin/PublishPanel.tsx:38-44`、`:146-153`
- `apps/web/src/admin/ImportReview.tsx:64-70`、`:108`
- `apps/web/src/admin/BatchImportPanel.tsx:359-361`
- `server/src/routes/admin-imports.ts:50`、`:234-356`
- `server/src/import/apply-incremental.ts:1-8`
- `server/src/import/reanalyze.ts:19`
