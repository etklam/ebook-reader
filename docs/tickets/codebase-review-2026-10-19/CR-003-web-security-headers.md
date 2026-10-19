# CR-003｜為 Web HTML 回應補上安全標頭

- 嚴重度：中
- 優先級：P2
- 工作量：小至中
- 類型：AFK
- 狀態：implemented-local

## 要做的事

API 經 `server/src/http/security.ts` 已有 CSP、`nosniff`、`Referrer-Policy` 與 HSTS，但 SPA 的 HTML 由 nginx 直接提供，`ops/nginx/ebook.conf` 的 `location /` 沒有任何安全標頭。瀏覽器載入 `index.html` 時只拿到 nginx 預設值，CSP 與其他保護不會套用到前端文件。

本票要為 HTML 與靜態資源補上與目前前端相容的安全標頭，先以 report-only 觀察，再切換成強制模式。

## 驗收條件（按最終實作修訂）

- [x] HTML、fallback、assets 與 404 帶 enforce CSP 及基本安全標頭，共用 include 避免 inheritance 遺失。
- [x] 真 nginx header/gzip/cache/API smoke 通過，built app 的 reader/search/TOC/admin-import CSP 流程通過。
- [x] CI release 加入 HTML CSP、nosniff、no-cache smoke。
- [ ] Production rollout 與實體語音／裝置相容性驗收完成。

## 不在範圍

第三方 analytics、nonce-based CSP、Trusted Types、前端套件來源改動。目前 `index.html` 沒有 inline script，先以 `'self'` 為主，不需要為了 CSP 大改 build。

## 依賴

無。CR-012 的 nginx 調整會碰同一個檔案，建議兩張票協調先後；先完成 CR-003 再處理快取。

## 實作提示

- 在 `server` block 設預設 header，`location = /healthz` 因已有 `add_header Content-Type` 需單獨確認。
- `style-src` 可能需要 `'unsafe-inline'`，因 React 會產生 style attribute；先用 report-only 確認實際需求，不要盲目放寬 script-src。
- 不要只在 API 加 header；HTML 文件必須由 nginx 回應。

## 審查依據

- `ops/nginx/ebook.conf:6-37`：server 與 `location /` 沒有安全標頭
- `server/src/http/security.ts:20-34`：API 專用標頭
- `apps/web/index.html`：無 inline script

## 2026-10-19–20 實作結果

安全加固已實作，並以真 nginx 容器驗證標頭；沒有發現或聲稱已證實的 XSS exploit。嚴重度調整為中、P2。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
