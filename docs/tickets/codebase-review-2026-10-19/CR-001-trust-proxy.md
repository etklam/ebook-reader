# CR-001｜修正 production rate limit 與可信 client IP

- 嚴重度：極高
- 優先級：P1
- 工作量：小至中
- 類型：AFK
- 狀態：implemented-local

## 要做的事

production API 目前沒有設定 `TRUST_PROXY`，而 nginx 會把請求轉到 API。API 的 `clientIp()` 在 `trustProxy=false` 時改用 socket remote address，因此所有讀者都會落到同一個 nginx pod IP bucket：登入是全站 60 次／5 分鐘、書內搜尋是全站 10 次／分鐘、點擊榜是全站 60 次／分鐘。流量稍高就會全站一起 429。

同時，nginx 使用 `$proxy_add_x_forwarded_for`，會保留 client 自行送入的 `X-Forwarded-For`；即使只把 `TRUST_PROXY` 設為 true，目前取 left-most 值的實作仍可被偽造 header 繞過。

本票要建立一條明確可信的 client IP 鏈，令 rate limit、審計日誌與排行榜使用真實但不可偽造的來源地址。

## 驗收條件（按最終實作修訂）

- [x] production 明確開啟 TRUST_PROXY；預設關閉、typo fail-closed 與 manifest guard 通過。
- [x] API 只接受單一合法地址；nginx 覆寫 XFF，兩個模擬可信 ingress client 經真 nginx 使用獨立 buckets，改偽造 XFF 不能增加額度。
- [x] 新增 web/API ingress NetworkPolicy，部署順序及來源信任鏈已記錄。
- [ ] Production Traefik forwardedHeaders、實際 CNI enforcement、不同外部 client 與可選 IP 日誌經現場驗收。

## 不在範圍

分散式 rate limiter（Redis／edge quota）、WAF、DDoS 防護與帳號層級的並發登入限制。這些屬 edge／infra 工作，不在本票假裝完成。

## 依賴

無，可獨立開始。需要 production 部署拓撲與 Traefik 設定的存取權。

## 實作提示

- `server/src/config.ts:120` 的 default 保持 `false`，由 deployment 明確開啟，不要改成預設信任。
- `server/src/http/rate-limit.ts:112-121` 目前取 XFF 第一個值；若保留這種解析方式，前面必須有可信 hop 保證該值不可由 client 偽造。
- `server/src/index.ts:57` 的 request logger 使用同一個 trust 設定，修正後一併受益。
- 若短期內無法安全建立信任鏈，先把 IP-based limit 改成「edge 已限流 + 應用層只做寬鬆保護」，不要把 shared bucket 當成有效保護。

## 審查依據

- `ops/k8s/production/03-api-worker.yaml:29-52`：API env 沒有 `TRUST_PROXY`
- `ops/nginx/ebook.conf:19-21,27-30`：`$proxy_add_x_forwarded_for`
- `server/src/http/rate-limit.ts:112-121`
- `server/src/routes/search-export.ts:42-44`：搜尋 10 次／分鐘
- `server/src/routes/auth.ts:35-43`：登入／註冊 IP limit
- `server/src/routes/rankings.ts:15-18`：點擊 60 次／分鐘

## 2026-10-19–20 實作結果

單一合法 IP 契約、nginx 覆寫 XFF、明確 TRUST_PROXY、ingress NetworkPolicy 及先隔離後 rollout 已實作。實際 Traefik／CNI 隔離及不同真實 client 的 production 檢查仍須現場驗收。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
