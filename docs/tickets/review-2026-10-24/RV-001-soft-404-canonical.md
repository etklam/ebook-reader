# RV-001｜消除 soft-404 與自我 canonical 造成的無限重複 URL

- 嚴重度：極高
- 優先級：P1
- 工作量：中
- 類型：HITL（需決定 404 status 由哪一層負責）
- 狀態：implemented-local（2026-10-24，head 層；404 status 層未做）

## 要做的事

任何不符合任何 route 的 path 都回 HTTP 200、render catalog 內容，並且宣告自己是 canonical。本票要令「不存在的 URL」對 crawler 而言確實不存在，而不是又一份 catalog 的複本。

## 分析

三個各自合理的決定疊在一起，造成同一個後果。

1. `apps/web/src/App.tsx:89`：`parsePath()` 最後一行是 `return { page: 'catalog' }`。註釋（`App.tsx:56-59`）解釋得清楚：`/works/nonsense` 寧願 fall through 回 catalog，也不要為一條本 app 從未發出過的 URL render 永久「找不到」。對人類讀者而言這是正確取捨。
2. `apps/web/src/App.tsx:141`：`applyHead({ ...info, canonicalPath: info.noindex ? undefined : path })`，其中 `path` 是原本的 `location.pathname`。catalog 的 `staticHead()` 沒有 `noindex`，因此任何 fall through 進來的 path 都會得到 `<link rel="canonical" href="<自己>">`。
3. `ops/nginx/ebook.conf:73-77`：`try_files $uri $uri/ /index.html` 令 HTTP 層同樣是 200。

合併結果：`/anything`、`/rankings/`、`/me`、`/works/nonsense` 每一條都是一頁「內容等於 catalog、status 200、canonical 指向自己」。canonical 的語義正是「不要把我併入其他 URL，我是正本」，所以 crawler 得不到任何可以收斂的訊號。URL 空間無上限，crawl budget 被消耗，catalog 本身的排名被自己的複本稀釋。

第二半問題在 not-found 狀態。`apps/web/src/catalog/WorkDetailPage.tsx:131` 的 error branch 直接 `return <EmptyState .../>`，而寫 head 的 effect（`:66-67`）第一行就 `if (!work) return`。`ReaderPage.tsx` 是同一個形狀：`LoadState.phase === 'error'` 有完整文案（`:54-60`、`:71-77`），但 head effect（`:302-303`）同樣 `if (!work || !chapter) return`。因此：

- cold load 一條失效的 `/works/<slug>-<deadbeef>`：title 是 index.html 的 `書庫`、description 是 catalog 的靜態描述、沒有 `noindex`。
- 由 SPA 導航進入：保留上一條 route 的 title／description／canonical，即一頁「找不到這部作品」會頂着另一本書的 metadata 被收錄。

值得對照的是 server 側已經做對：`server/test/e2e-seo.test.ts:188-197`（SEO-03）明確 assert「沒有可用 key 的 segment 是 404，不是掃描」。缺的只是 web 側對應的行為。

修正分兩層，可獨立進行：

- **head 層（小，純前端）**：`parsePath` 增加一個 `notFound` route，`staticHead()` 為它設 `noindex: true` 與固定 title；WorkDetailPage／ReaderPage 的 error branch 各自 `applyHead({ title: …, noindex: true })`。這一層即可止住重複收錄。
- **status 層（需決策）**：真正的 404 status 必須由 nginx 或 prerender／SSR hop 發出；純 SPA 做不到 —— JS 執行時 response 已經送出。選項：(a) 接受 200 + `noindex`，只靠 robots 訊號；(b) nginx 以已知前綴白名單（`/`、`/works/`、`/read/`、`/rankings`、`/login`、`/register`、`/me/`、`/admin`）決定是否 fallback 到 `/index.html`，其餘 `return 404`；(c) 留待將來 prerender 一次解決。(b) 的代價是 nginx 白名單必須與 `parsePath` 保持同步，而本 repo 已有一組同類的同步問題（見 RV-008），因此選 (b) 必須同時附 drift guard。

## 驗收條件

- [ ] 不符合任何 route 的 path 不再輸出 `<link rel="canonical">`，並帶 `meta robots noindex`。
- [ ] `/rankings/`、`/me`、`/works/nonsense`、`/read/nonsense` 各有測試 pin 住此行為。
- [ ] WorkDetailPage 與 ReaderPage 的 not-found／forbidden 狀態會主動寫 head：固定 title、`noindex`、沒有 canonical，並清掉上一條 route 留下的 description 與 `og:*`。
- [ ] 選定 404 status 方案並記錄理由；若選 (b)，nginx 白名單與 `parsePath` 之間有自動 drift guard。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm --filter web test:browser` 通過。

## 不在範圍

SSR／prerender（與 RV-003 指向同一塊基礎工作，但不是本票的前置條件）、catalog 的 query 參數 canonical（`App.tsx:133` 已正確 strip `?` 與 `#`）。

## 依賴

無。head 層可獨立開始；status 層需人工決定方案。

## 實作結果（2026-10-24）

只做 head 層；status 層仍未決定，故本票維持部分完成。

`parsePath` 新增 `notFound` route：`/` 仍是 `catalog`，其餘不匹配的 path 回 `notFound`。兩者都 render `CatalogPage`（fall-through 的原意保留，讀者不會卡住），但 `staticHead().notFound` 給它固定 title、`noindex: true`、**不給** canonical。`App.tsx` 的 `canonicalPath: info.noindex ? undefined : path` 本來就會因此跳過 canonical，所以不需要額外分支。

`WorkDetailPage` 與 `ReaderPage` 各新增一個 effect，在 error 狀態主動寫 head（固定 title + `noindex`，無 canonical、無 JSON-LD）。因為 `applyHead` 的清除迴圈會移除所有未被新 route 設定的 `data-head` 標籤，上一頁的 description 與 `og:*` 會一併消失 —— 這正是「找不到這部作品」不再頂着另一本書 metadata 的機制。

**未完成：** 404 HTTP status。選項 (a)／(b)／(c) 仍未決定，目前等同採用 (a)（200 + `noindex`）但未正式記錄為決定。(b) 需要改 nginx 並新增一個 nginx↔`parsePath` 的 drift guard，無法在本機驗證，留待人工決定。

驗證：`pnpm lint`、`pnpm typecheck`、server 151／web 74 單元測試全過。新增 `apps/web/e2e/seo.spec.ts` 覆蓋 `/rankings/`、`/me`、`/works/nonsense`、`/read/nonsense`、`/no-such-page` 與 not-found 狀態，**但未執行** —— Playwright 需要 dev server 與 API。

## 審查依據

- `apps/web/src/App.tsx:56-59`、`:89`、`:141`
- `apps/web/src/catalog/WorkDetailPage.tsx:66-67`、`:131-140`
- `apps/web/src/reader/ReaderPage.tsx:54-77`、`:302-318`
- `ops/nginx/ebook.conf:73-77`
- `server/test/e2e-seo.test.ts:188-197`（server 側已正確，作為對照）
