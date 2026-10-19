# 2026-10-19 程式碼檢視改善 tickets

建立日期：2026-10-19。來源：目前 codebase 的唯讀檢視（server、web、ops）；基線 `pnpm typecheck`、`pnpm lint`、`pnpm test` 通過。

本批共 13 張 tickets，已完成本機實作與驗證，狀態為 `implemented-local`。新增 migration 0014／0015、程式及部署設定；production rollout 與真機驗證仍需另外確認。詳見 [實作與驗證](verification.md)。

## 優先級與嚴重度

- **嚴重度**：極高／高／中高／中／低至中／低，代表問題對 production 正確性、安全性或資料完整性的影響。
- **優先級**：P1／P2／P3，代表排程次序，不是事故嚴重度。P1 先做，P2 接續，P3 選配。
- **AFK**：範圍已具體化，可由 agent 接手；**HITL**：實作前需要人工確認 ticket 內列出的決策。
- 工作量為相對估計，非工期承諾；開發時仍須重新檢查當時程式碼與部署拓撲。

## 索引

| ID | Ticket | 嚴重度 | 優先級 | 工作量 | 類型 | 阻塞依賴 | 狀態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CR-001 | [修正 production rate limit 與可信 client IP](CR-001-trust-proxy.md) | 極高 | P1 | 小至中 | AFK | 無 | implemented-local |
| CR-002 | [修正閱讀器上一頁／下一頁切章](CR-002-reader-history.md) | 高 | P1 | 小 | AFK | 無 | implemented-local |
| CR-003 | [為 Web HTML 回應補上安全標頭](CR-003-web-security-headers.md) | 中 | P2 | 小至中 | AFK | 無 | implemented-local |
| CR-004 | [序列化會員進度同步寫入](CR-004-progress-sync-single-flight.md) | 高 | P1 | 小至中 | AFK | ER-009（政策部分） | implemented-local |
| CR-005 | [量測並改善書內全文搜尋的整本掃描](CR-005-search-index.md) | 中高 | P2 | 中至大 | AFK | ER-012 | implemented-local |
| CR-006 | [移除目錄每次請求的全書版本 hash](CR-006-toc-version-cost.md) | 中 | P2 | 中 | AFK | 無 | implemented-local |
| CR-007 | [消除登入帳號列舉的 timing side channel](CR-007-login-timing.md) | 中 | P2 | 小 | AFK | 無 | implemented-local |
| CR-008 | [目錄搜尋加入 debounce 與請求取消](CR-008-toc-search-debounce.md) | 中 | P2 | 小 | AFK | ER-004 | implemented-local |
| CR-009 | [書內搜尋結果改用 SPA 導航](CR-009-search-spa-navigation.md) | 中 | P2 | 小 | AFK | CR-002 | implemented-local |
| CR-010 | [加入 react-hooks lint 並分拆 ReaderPage](CR-010-reader-page-maintainability.md) | 中 | P3 | 中至大 | AFK | CR-002、CR-004 | implemented-local |
| CR-011 | [為大型作品匯出加入記憶體上限或串流](CR-011-export-memory.md) | 中 | P3 | 中 | AFK（A 已選定） | 無 | implemented-local |
| CR-012 | [補上 nginx 靜態快取與基本硬化](CR-012-nginx-caching-hardening.md) | 低至中 | P3 | 小 | AFK | CR-003 | implemented-local |
| CR-013 | [移除重複索引](CR-013-redundant-indexes.md) | 低 | P3 | 小 | AFK | 無 | implemented-local |

## 建議執行次序

1. CR-001：production 目前所有 IP-based limit 會落到同一個 bucket，優先處理。
2. CR-002：reader 的基本瀏覽器上一頁／下一頁失效，屬日常閱讀路徑。
3. CR-003：HTML 安全標頭加固；沒有以缺少 CSP 斷言存在 XSS。
4. CR-004：與 ER-009 的衝突政策分開，先做機械性的寫入序列化。
5. CR-006：目錄版本計算成本隨書量線性上升。
6. CR-005：先量測，再決定是否建索引。
7. CR-007、CR-008、CR-009。
8. CR-010～CR-013：維護性與營運整理。

## 與既有 tickets 的關係

- **CR-004／ER-009**：ER-009 已記錄並行 flush 與過期回呼風險，但仍卡在衝突政策決策。CR-004 只處理「同一時間只有一個寫入、較舊回應不覆蓋較新狀態」的機械部分，不改「伺服器優先」政策；完成後可勾銷 ER-009 的相關驗收項。
- **CR-005／ER-012**：ER-012 已做提早回傳與接續游標，但明確保留「無命中仍可能掃完整本」。CR-005 只處理這個已量測到的剩餘限制，不重做游標或前端分頁。
- **CR-008／ER-004**：ER-004 已交付目錄搜尋與排序；CR-008 只補前端輸入節流與取消，不改 server 搜尋語義。
- **CR-009／CR-002**：搜尋結果改成 SPA 導航前，必須先確保 reader 正確處理章節 prop 變化，否則會放大切章問題。
- **CR-010**：建議在 CR-002、CR-004 完成後才開始，避免同一段 reader 邏輯反覆衝突。

## 共通驗證

每張 AFK ticket 完成時至少需要：

```sh
pnpm lint
pnpm typecheck
pnpm test
```

涉及資料庫、匯入、發布或搜尋契約的 ticket 另需 `pnpm --filter server test:e2e` 與 `pnpm db:verify`；涉及閱讀器互動的 ticket 另需 `pnpm --filter web test:browser`。真機 L3 不會被瀏覽器自動化取代，未執行項目須如實記錄。

## 完成狀態解讀

`implemented-local` 表示實作與本機驗證完成。Production Traefik／CNI、rollout 與實體手機條件仍須按 [驗證紀錄](verification.md) 驗收。原 ticket 的提議如與最終結果不同，以各票實作結果與驗證紀錄為準。CR-006 使用獨立 generation；CR-005 使用完整正文候選索引；CR-011 選用經量測的 16MiB 上限。
