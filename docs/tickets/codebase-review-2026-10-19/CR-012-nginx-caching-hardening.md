# CR-012｜補上 nginx 靜態快取與基本硬化

- 嚴重度：低至中
- 優先級：P3
- 工作量：小
- 類型：AFK
- 狀態：implemented-local

## 要做的事

`ops/nginx/ebook.conf` 目前只用 `try_files` 提供 SPA，沒有 static cache、壓縮或基本硬化：

- Vite 產生的 hashed assets 沒有 `Cache-Control`，每次都可能重新驗證；
- `index.html` 沒有明確的 `no-cache`，部署後可能短暫拿到舊殼；
- 沒有 gzip／brotli；
- 沒有 `server_tokens off`；
- `client_max_body_size 55m` 與 `IMPORT_MAX_EPUB_BYTES` 預設 50MiB 只是剛好相容，日後調高 import limit 會先被 nginx 擋下。

本票只改 nginx 靜態層，不動 API 或前端 build 產物。

## 驗收條件（按最終實作修訂）

- [x] hashed assets immutable 1 年，HTML/fallback no-cache；gzip、server_tokens off 完成。
- [x] 真 nginx 檢查 HTML、fallback、asset、404、API headers/status 通過，安全標頭保留。
- [x] 55m 與目前 upload limit 相容，API quota 調高時同步 nginx 的部署要求已記錄。
- [ ] 跨 production rollout 舊 assets 保留／重載流程驗收完成。

## 不在範圍

CDN、HTTP/3、圖片最佳化、前端 bundle 拆分。也不改 API cache 語義。

## 依賴

CR-003 會修改同一個 nginx 設定；建議先完成安全標頭，再加 cache，避免兩組 `add_header` 互相覆蓋。

## 實作提示

- `location /` 的 fallback 會服務 `index.html`；`try_files` 命中的靜態檔與 fallback 可能需要分開處理，否則 HTML 會誤拿 immutable cache。
- Vite 預設輸出 `assets/[name]-[hash].js`；先確認 build 產物命名再寫 rule。
- 若使用 `add_header` 在 `location` 覆寫，記得把安全標頭一併重列或改用 `include`。
- `client_max_body_size` 是 nginx 層限制；API 的 bodyLimit 仍是最終權威，兩者都要一致。

## 審查依據

- `ops/nginx/ebook.conf:6-37`
- `server/src/config.ts:112-115`
- `server/src/routes/admin-imports.ts:45-46`

## 2026-10-19–20 實作結果

immutable assets、HTML no-cache、gzip、版本隱藏及 shared security include 已完成，真 nginx smoke 通過。保留舊 assets 是部署策略，不能單靠 header 保證。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
