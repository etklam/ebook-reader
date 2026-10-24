# RV-007｜SITE_ORIGIN 缺 deployment drift guard，robots.txt 前綴不一致

- 嚴重度：低
- 優先級：P3
- 工作量：小
- 類型：AFK
- 狀態：implemented-local（2026-10-24）

## 要做的事

`SITE_ORIGIN` 的 fallback 行為有測試 pin 住，但 production manifest 是否真的設定了它沒有任何自動檢查 —— 與 `TRUST_PROXY` 的處理方式不一致。同時 robots.txt 的路徑前綴寫法不統一。

## 分析

### SITE_ORIGIN 的 guard 落差

`server/src/routes/sitemap.ts:33-40` 的 `origin()`：設定了 `SITE_ORIGIN` 就用它，否則 fallback 到請求自己的 `Host` 與 `x-forwarded-proto`，並附註釋「dev fallback: trusts the Host header, which is why production sets SITE_ORIGIN」。

這個設計本身是對的，而且行為覆蓋得很好：

- `server/src/routes/sitemap.test.ts:128-133`：設定了 SITE_ORIGIN 時偽造 Host 不會洩漏進輸出；
- `server/src/routes/sitemap.test.ts:120-126`：未設定時用請求 origin；
- `server/test/e2e-seo.test.ts:287-299`（SEO-09）：兩種情況都 assert。

缺的是另一半 —— 沒有任何東西保證 production 真的設定了它。對比 `TRUST_PROXY`：`server/src/http/deployment.test.ts:11-12` 直接讀 `ops/k8s/production/03-api-worker.yaml` 並 `assert.match(api, /name: TRUST_PROXY\s+value: "true"/)`。`SITE_ORIGIN` 確實在 `ops/k8s/production/03-api-worker.yaml:51` 有設定，但沒有對應的 assertion，所以一次 manifest 重構就可以靜默移除它。

一旦漏設，後果具體如下：nginx 的 `server_name _`（`ops/nginx/ebook.conf:5`）接受任何 Host，而 `proxy_set_header Host $host`（`:38`）把 client 的 Host 原樣轉給 API。於是 `Host: evil.example` 會令 robots.txt 輸出 `Sitemap: https://evil.example/sitemap.xml`，而該回應帶 `Cache-Control: public, max-age=3600`（`sitemap.ts:31`）—— 偽造值會被緩存一小時。

嚴重度定為「低」而非更高，因為：(a) production 目前有設定；(b) `httpOrigin()`（`server/src/config.ts:154`）會驗證格式，typo 不會變成靜默的半套設定。本票要補的是把現狀鎖住的那一行。

### robots.txt 前綴不一致

`sitemap.ts:79-90` 的 Disallow 清單：

```
Disallow: /admin      ← 無尾斜線，前綴比對，涵蓋 /admin 及其下所有路徑
Disallow: /me/        ← 有尾斜線，不涵蓋 /me 本身
Disallow: /login
Disallow: /register
Disallow: /api/
```

`/me` 本身目前不是 route（`App.tsx:85-87` 只有 `/me/library`、`/me/bookmarks`、`/me/reading-stats`），所以現在沒有實際洩漏。但 `/me` 會 fall through 到 catalog（即 RV-001 的問題），而它沒有被 robots 擋住 —— 兩票合起來，`/me` 是一條可被收錄、內容等於 catalog、canonical 指向自己的 URL。修正 RV-001 後此項自動變成純一致性問題。

順帶一提，`Allow: /` 置於 Disallow 之前不是問題：robots.txt 以最長前綴匹配決定，不是順序。

## 驗收條件

- [ ] `server/src/http/deployment.test.ts`（或等價的 drift guard）assert production manifest 設定了 `SITE_ORIGIN`，並且值是 `https://` 開頭的絕對 origin。
- [ ] robots.txt 的 Disallow 前綴寫法統一，並在票內記錄選定的規則（建議全部不帶尾斜線，與 `/admin` 一致）。
- [ ] 現有 `sitemap.test.ts` 的 robots.txt assertion 隨之更新。
- [ ] `pnpm test` 通過。

## 不在範圍

改變 `SITE_ORIGIN` 未設定時的 fallback 行為（dev 需要它），nginx 的 Host 白名單（屬 ingress 層，與 CR-001 的 Traefik 驗收同一塊）。

## 依賴

`/me` 的收錄問題由 RV-001 處理；本票只處理前綴一致性。

## 實作結果（2026-10-24）

`deployment.test.ts` 加一行：assert production manifest 的 `SITE_ORIGIN` 存在且是 `https://` 絕對 origin（manifest 的值未加引號，regex 兩種都接受）。與既有的 `TRUST_PROXY` assertion 並列，註釋寫明漏設時的具體後果（偽造 Host 進入 `max-age=3600` 的 robots.txt）。

robots.txt 的 `Disallow: /me/` 改成 `/me`，與 `/admin` 一致，並在程式與測試各留一句說明理由（robots.txt 是最長前綴比對，不是路徑分段）。`sitemap.test.ts` 與 `server/test/e2e-seo.test.ts` 的 assertion 一併更新；`sitemap.test.ts` 另加一條 `^Disallow: \/me$` 的 regex，確保尾斜線不會悄悄回來。

驗證：`pnpm lint`、`pnpm typecheck`、server 151 項全過。

## 審查依據

- `server/src/routes/sitemap.ts:31`、`:33-40`、`:74-93`
- `server/src/config.ts:154`
- `server/src/http/deployment.test.ts:6-21`
- `ops/k8s/production/03-api-worker.yaml:51`
- `ops/nginx/ebook.conf:5`、`:38`
