# CR-009｜書內搜尋結果改用 SPA 導航

- 嚴重度：中
- 優先級：P2
- 工作量：小
- 類型：AFK
- 狀態：implemented-local

## 要做的事

書內全文搜尋結果目前用原生 `<a href={result.href}>`。點擊會觸發整頁 reload，丢失閱讀器的 scroll、語音播放、未 flush 的進度與目前搜尋狀態；亦會令章節深鏈依賴頁面重新初始化。

本票把結果連結改成現有的 `navigate()` SPA 導航，並確保 `ReaderPage` 正確處理 `#p=…&rev=…`。

## 驗收條件（按最終實作修訂）

- [x] 普通結果點擊改 SPA；保留連結與 modifier 操作，導航後關閉搜尋面板。
- [x] 正確載入目標章／段落、同章 hash 及直接深鏈；瀏覽器返回由 CR-002 保證。
- [x] 進度在導航時擷取／序列化；跨章 TTS 保持既有策略，不承諾繼續舊章語音。
- [x] 搜尋分頁、段落定位、無整頁 document 重建的回歸通過。

## 不在範圍

搜尋索引與後端分頁（CR-005／ER-012）、搜尋 UI 重設計、跨作品搜尋。

## 依賴

- CR-002 必須先完成，否則改用 SPA 導航會直接觸發「prop 變了但 reader 不換章」的 bug。
- 搜尋 API 的 href 契約不變。

## 實作提示

- `apps/web/src/reader/FullTextSearch.tsx:90` 改成 button 或以 `onClick` preventDefault 後呼叫 `navigate(result.href)`。
- `navigate()` 只做 pushState + popstate；reader 需要正確解析 hash，現有 `parsePositionHash` 可重用。
- 若保留 `<a>` 的語義，至少加 `onClick` 攔截並處理 modifier key（Ctrl/Cmd 點擊應開新 tab）。
- 導航前是否需要 flush 目前進度，依 CR-004 的序列化行為決定。

## 審查依據

- `apps/web/src/reader/FullTextSearch.tsx:90`
- `apps/web/src/App.tsx:71-76`：既有 `navigate()`
- `apps/web/src/reader/ReaderPage.tsx:258-265`：deep link hash 解析

## 2026-10-19–20 實作結果

普通點擊 SPA、modifier 開新分頁、同章 hash、不同章定位及瀏覽器返回已實作。搜尋面板於導航後關閉；跨章依現有 TTS 規則處理，不繼續播放舊章。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
