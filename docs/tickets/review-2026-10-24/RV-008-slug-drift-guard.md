# RV-008｜兩份 slug.ts 的 drift guard（已存在，只補 ref key 規則）

- 嚴重度：低
- 優先級：P3
- 工作量：小
- 類型：AFK
- 狀態：implemented-local（2026-10-24）

## 要做的事

> **本票的原始前提是錯的。** 開票時記錄為「兩份 `slug.ts` 沒有任何自動檢查」，但檢視時只比對了兩個 `.ts` 來源並對 `.test.ts` 跑了 `diff -q`，沒有讀測試內容。實際上 `server/src/lib/slug.test.ts` 早已有 drift guard，而且範圍劃得正確。本票縮減為補上該 guard 刻意排除、但其實有意義的那一小塊。

## 分析

### 已經存在的部分

`server/src/lib/slug.test.ts` 的 `the web copy of the slug rules is byte-identical`：讀取兩份檔案，截取 `const SLUG_MAX` 到 `slugWithId` 結尾之間的區塊，逐字比對。涵蓋 `SLUG_MAX`、`KEEP` 字元類、`slugify`、`slugWithId` —— 即所有會影響 URL 外形的規則。

它的註釋亦說明了為何不比對 `parseRef`：「The ref parsers are intentionally not identical (they return differently named keys for their own callers) and are covered behaviourally above」。這個判斷是對的，`parseRef` 在 server 回 `{ workId }`、在 web 回 `{ uuid }`。

已以人工製造漂移驗證該測試會失敗（把 web 的 `SLUG_MAX` 改成 41 → 測試紅）。

### 真正剩下的缺口

`parseRef` 的**函式本體**可以合理地不同，但「什麼算一個 key」不應該不同。兩份各自宣告：

```ts
const PUBLIC_ID_RE = /^[0-9a-f]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

這兩條不在既有 guard 的截取範圍內，而它們分工於兩個不同的決定：server 決定一條 sitemap URL 能否解析（`e2e-seo.test.ts:188-197` 的 SEO-03），web 的 `parsePath` 決定它**是不是一條 route**（`App.tsx:76-82`）。只有一邊放寬或收緊，結果是 sitemap 廣告了一條 URL，而 app 用 catalog 回答它 —— 與 RV-001 修的是同一種病，只是入口不同。

### 做法

延伸既有 guard，額外抽出兩行 `const PUBLIC_ID_RE` / `const UUID_RE` 比對。不比對 `parseRef` 本體（保留原有判斷），不建立共用 package（兩份檔案的檔頭註釋已論證過，約 40 行不值得一個 build graph）。

## 驗收條件

- [x] 既有的 `slugify` 規則 guard 已確認存在且有效（以人工漂移驗證會失敗）。
- [x] guard 延伸至 `PUBLIC_ID_RE` 與 `UUID_RE`，並以人工漂移驗證會失敗。
- [x] 不比對 `parseRef` 本體；原因寫在測試註釋內。
- [x] `pnpm test` 通過。

## 不在範圍

建立共用 package、統一 `parseRef` 的回傳鍵名（純命名，無行為影響）、兩份 `slug.test.ts` 的案例差異（web 版涵蓋較多邊界，屬刻意，不需要對齊）。

## 實作結果（2026-10-24）

`server/src/lib/slug.test.ts` 的 drift guard 加入第二段比對：以 `^const (PUBLIC_ID_RE|UUID_RE) = ` 抽出兩行並要求逐字相同，找不到兩行時直接失敗（避免 guard 因改名而靜默變成空檢查）。負面驗證：把 web 的 `PUBLIC_ID_RE` 改成 `{9}` 後測試紅，訊息為「the two copies disagree on what counts as a public id or a uuid」。

## 審查依據

- `server/src/lib/slug.test.ts`（既有 guard 與其範圍註釋）
- `server/src/lib/slug.ts:70-71`、`apps/web/src/lib/slug.ts:70-71`
- `apps/web/src/App.tsx:76-82`
- `server/test/e2e-seo.test.ts:188-197`
