# RV-018｜PWA：可安裝、app shell 與 service worker 基礎

- 嚴重度：不適用（功能需求）
- 優先級：P2
- 工作量：中
- 類型：AFK
- 狀態：open

## 要做的事

讓這個網站可以被加到主畫面並以獨立視窗開啟：web app manifest、圖示、service worker 與 app shell 快取。**不**包含章節內容的離線下載 —— 那是 ER-007。

## 分析

### 現狀：完全沒有

`apps/web` 原本沒有 `public/` 目錄，`index.html` 沒有 `manifest`、沒有 `favicon`、沒有 `apple-touch-icon`，全 repo 沒有 service worker。網站現在連一個分頁圖示都沒有。

本票開票時已一併產出圖示（見下），其餘都還沒有。

### 圖示（已完成）

`apps/web/public/` 新增三個 SVG：

| 檔案 | 用途 |
| --- | --- |
| `icon.svg` | `purpose: any`，圓角方形滿版，供 192／512 PNG 產製 |
| `icon-maskable.svg` | `purpose: maskable`，滿版方形，圖形收在中央 80% 安全圓內（半徑約 171，上限 204.8） |
| `favicon.svg` | 16–32px 專用，三條書脊，重畫而非縮放 |

圖形是一排書脊而不是一本翻開的書：每個閱讀器都是翻開的書，而「書庫」是一個書架；四條寬度不一的長條配一條層板在 16px 仍然認得出，一頁帶捲角的書不行。其中一條深色書脊是「正在讀的那本」—— 縮到 favicon 尺寸時，單一色彩重點是唯一還讀得出的資訊。顏色全部取自 `tokens.css` 的 oklch token 轉成的 hex：brand `#855b05`、ink `#1f1b14`、surface `#faf8f6`、brand-tint `#fdf2e1`。

仍需處理：**PNG 產製**。部分平台（尤其舊版 Android 與 iOS 的 `apple-touch-icon`）不吃 SVG。需要 192／512 PNG 與一個 180 的 `apple-touch-icon`，而 repo 目前沒有任何光柵化工具鏈。選項：建置時用一個 devDependency 光柵化，或產製一次後把 PNG 提交進 repo。後者省一個依賴，代價是圖示改動時要記得重跑 —— 若選這條，需要一個 drift guard（對照 SVG 的 hash）。

### Service worker：這是真正需要小心的部分

這個站的內容契約對快取其實友善：release 不可變、章節正文以 `revisionId` 定身分、sitemap 與 API 都有明確的版本概念。但 service worker 一旦裝上就很難收回，錯誤的快取策略會讓讀者卡在舊版前端而且自己無法脫身。

建議的最小策略：

- **app shell（HTML／JS／CSS）**：預快取，`stale-while-revalidate`，但 `index.html` 一定要是網路優先。nginx 已經把 `/index.html` 與 `/` 設成 `Cache-Control: no-cache`、`/assets/` 設成 `immutable`（`ops/nginx/ebook.conf:62-77`），service worker 的策略必須與這組標頭一致，不能各講各的。
- **API 回應**：**一律不快取**。進度、書籤、會員狀態全都是個人化且會寫入的；快取它們會造成「讀者看到自己三天前的進度」這種最難除錯的回報。
- **必須有逃生門**：新版 service worker 要能接管而不用讀者手動清快取（`skipWaiting` + `clients.claim`，或一個明確的「有新版本，重新載入」提示）。並且要有一個可以註銷 service worker 的路徑，以防策略寫錯了要止血。

### 可安裝性的其他部分

- manifest 需要 `name`、`short_name`、`start_url`、`scope`、`display: standalone`、`theme_color`、`background_color`、`icons`、`lang: zh-Hant`、`orientation`。`theme_color` 與 `background_color` 應取自 `index.html` 既有的 `theme-color`（light `#faf8f6`／dark `#151515`）。
- `display: standalone` 之後**沒有瀏覽器的返回鍵**。這個 app 的路由是自家 `pushState`／`popstate`（`App.tsx:118-131`），閱讀器又大量使用 `history.replaceState` 做 canonical 修正（`ReaderPage.tsx:306`、`use-reader-entry.ts:49`）。獨立視窗下必須確認返回行為仍然可用 —— 這是 CR-002 處理過的同一塊區域，值得重新驗一次。
- `start_url` 應帶一個識別參數，否則無法分辨安裝後的流量；但要確認它不會變成 RV-001 修掉的那種 canonical 重複。
- iOS：Safari 不支援 manifest 的大部分欄位，要靠 `apple-mobile-web-app-*` meta 與 `apple-touch-icon`。iOS 的 service worker 儲存配額也會被系統回收。限制要寫明，不要讓「可安裝」聽起來三個平台一樣。

## 驗收條件

- [ ] `manifest.webmanifest` 齊備上列欄位，Lighthouse 的可安裝性檢查通過。
- [ ] 圖示涵蓋 `any` 與 `maskable` 兩種 purpose；192／512 PNG 與 180 `apple-touch-icon` 已產製，且 PNG 與 SVG 之間有防漂移機制。
- [ ] service worker 的快取策略與 nginx 既有標頭一致；`index.html` 網路優先。
- [ ] 任何 `/api/` 回應都不被 service worker 快取，並有測試或明確的策略斷言。
- [ ] 前端發新版後，讀者不需手動清快取即可取得新版；提供可註銷 service worker 的止血路徑。
- [ ] `display: standalone` 下閱讀器的上一頁／下一頁、切章與 canonical 位址改寫行為正確（重驗 CR-002 的範圍）。
- [ ] `start_url` 的識別參數不產生可被收錄的重複 URL（與 RV-001 一致）。
- [ ] iOS 與 Android 的實際安裝與開啟已在真機驗證；兩者的差異與 iOS 的限制記錄在票內。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm --filter web test:browser` 通過。

## 不在範圍

章節內容的離線下載、儲存空間管理與回線後的版本處理 —— 全部屬 **ER-007**（狀態 `needs-triage`，決策未定）。本票只提供 ER-007 將來需要的 service worker 基礎，不預先決定它的任何政策。推播通知亦不在範圍。

## 依賴

ER-007 依賴本票，反之不然。與 RV-001 相關：`start_url` 不得製造新的重複 URL。

## 審查依據

- `apps/web/index.html`
- `apps/web/public/icon.svg`、`icon-maskable.svg`、`favicon.svg`
- `apps/web/src/styles/tokens.css:68-71`（brand token 來源）
- `ops/nginx/ebook.conf:62-77`
- `apps/web/src/App.tsx:118-131`、`apps/web/src/reader/ReaderPage.tsx:306`
- `docs/tickets/reader-improvements/ER-007-offline-chapters.md`
