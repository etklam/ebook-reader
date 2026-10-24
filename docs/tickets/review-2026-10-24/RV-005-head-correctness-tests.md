# RV-005｜head.ts 的正確性缺口與零測試覆蓋

- 嚴重度：中
- 優先級：P2
- 工作量：小至中
- 類型：AFK
- 狀態：implemented-local（2026-10-24）

## 要做的事

`apps/web/src/lib/head.ts` 是整個 client 側唯一決定 title／canonical／Open Graph 的模組，目前沒有任何測試。模組內另有兩個已確認的正確性缺口。本票要補測試並修正它們。

## 分析

### 覆蓋落差

`apps/web/src/lib/` 只有 `slug.test.ts`，沒有 `head.test.ts`；`apps/web/e2e/` 共 15 個 spec，沒有任何一個針對 head／SEO。對比之下 server 側的 SEO 覆蓋相當紮實：`server/src/routes/sitemap.test.ts` 9 個 case、`server/test/e2e-seo.test.ts` 9 個 SEO-0N case，連「Hono 的 `:page{[0-9]+}` 帶 literal prefix 不 match」這種陷阱都 pin 住了。落差完全集中在 client 側。

`head.ts` 本身是純 DOM 操作、沒有 React 依賴，用 `node:test` 配一個最小 DOM stub 即可測，成本很低。

### 缺口一：`og:title` 用 `String.replace` 去除站名後綴

`head.ts:87`：

```ts
metaTag('property', 'og:title', info.title.replace(` · ${site()}`, ''));
```

`String.prototype.replace` 傳字串時只替換**第一個出現位置**，而且不限於結尾。一本標題本身含有 `· 書庫` 字樣的書（或章節標題含此序列），`og:title` 會被從中間剪斷。

這是後綴剝離的根本脆弱之處：`title()`（`:41-44`）剛剛把站名接上去，`:87` 又把它拆回來。乾淨做法是 `HeadInfo` 直接多帶一個未加後綴的頁面標題欄位，`og:title` 用它，完全不做字串還原。

### 缺口二：index.html 的靜態 description 在首次 SPA 導航後被永久移除

`head.ts:99-101` 的註釋說明意圖：index.html 附帶一條靜態 description 給不執行 JS 的 crawler，所以此處用 upsert 而非 replace，避免出現兩條 description。

實際行為：

1. 冷啟動在 `/`：`:105-106` 找到 index.html 那條 `meta[name=description]`，`existing.replaceWith(next)`，而 `next` 帶 `data-head` 標記。靜態那條已經消失。
2. 導航到 `/login`（`staticHead()` 沒有為它設 description）：`:93-98` 的清除迴圈發現這條 `[data-head]` 不在 `keep` 內，把它移除。
3. 結果：頁面上完全沒有 description meta，而且靜態那條再也回不來。

實際影響有限 —— 不執行 JS 的 crawler 從來不會跑到這段程式碼，所以註釋聲稱的保護目標並未失效；受影響的只有會 render JS 的 crawler 落在無 description 的 route 上，而那些 route（`/login`、`/register`、`/me/*`、`/admin`）本來就被 robots.txt 擋住。因此本項定性為「行為與註釋不符、需要收斂」，而非正在造成損害的缺陷。

正確的收斂方向與 RV-003 一致：把 index.html 視為「靜態 floor」，`head.ts` 只覆寫而永不把 floor 刪到空。具體做法是清除迴圈只移除有 `data-head` 且**有對應靜態 fallback 以外**的標籤，或在移除後把 floor 值寫回去。

## 驗收條件

- [ ] 新增 `apps/web/src/lib/head.test.ts`，至少覆蓋：title 後綴規則、canonical 的有無、`noindex` 進出時 `meta robots` 與 canonical 的增刪、route 切換不繼承上一頁的 description／`og:*`。
- [ ] `og:title` 不再以字串還原取得；標題含 `· 書庫` 的個案有測試。
- [ ] description 的靜態 fallback 在任意 route 切換序列後仍然存在（或明確記錄為刻意移除並更新 `:99-101` 的註釋，兩者擇一，不可維持現狀的矛盾）。
- [ ] `apps/web/e2e/` 增加一個 SEO spec，於真實瀏覽器核對 catalog → 作品 → 章節 → 會員頁的 head 轉換。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm --filter web test:browser` 通過。

## 不在範圍

JSON-LD 與 `og:image`（RV-003）、`locale` 依賴（RV-004）、SSR。

## 依賴

無。與 RV-003、RV-004 同樣改動 `head.ts`，三票建議合併排程。

## 實作結果（2026-10-24）

`HeadInfo.title` 換成 `page?: string`（不含站名後綴），`applyHead` 自己用 `title(info.page)` 組出 document title，`og:title` 直接用 `info.page`。字串還原完全消失，三個呼叫端一併更新。測試 `og:title drops the suffix without string surgery on the title itself` 以一本標題含 `· 書庫` 的書 pin 住。

靜態 description 改成「floor」：模組載入時讀一次 index.html 的 `meta[name=description]`（必須在任何覆寫之前），之後任何沒有自己 description 的 route 都還原這一行，而不是留下空白。還原站級值不違反「不繼承其他頁的值」—— 測試 `a route without a description falls back to the static site line, never to none` 與 `one route never inherits another route description` 兩邊都 pin 住。

新增 `apps/web/src/lib/head.test.ts`：10 個 case，自帶一個最小 DOM stub（只支援 head.ts 實際用到的屬性選擇器）。stub 必須在 `import` 之前裝好，所以用帶 cache-buster 的動態 import 取得乾淨的模組狀態。

新增 `apps/web/e2e/seo.spec.ts`（11 個 case，**未執行**）。

驗證：`pnpm lint`、`pnpm typecheck`、server 151／web 74（含新增 10 項）全過。`pnpm --filter web test:browser` 未執行。

## 審查依據

- `apps/web/src/lib/head.ts:41-44`、`:87`、`:93-108`
- `apps/web/index.html`
- `server/src/routes/sitemap.test.ts`、`server/test/e2e-seo.test.ts`（server 側覆蓋水平，作為對照）
