# CR-008｜目錄搜尋加入 debounce 與請求取消

- 嚴重度：中
- 優先級：P2
- 工作量：小
- 類型：AFK
- 狀態：implemented-local

## 要做的事

目錄搜尋的 `query` 直接是 `load()` 的 dependency，而 `useEffect` 依賴 `[load]`，所以每次擊鍵都會：

- `setEntries([])` 清空目前列表；
- 把 scroll 定位重設；
- 發一個新的 TOC 請求。

`requestId` 只丟棄過期 response，請求本身仍然會送到 server。快速輸入時會浪費 API／DB，並造成列表閃爍與版本檢查競爭。

本票只改前端輸入節流與取消，不改 TOC server 的搜尋語義或排序。

## 驗收條件（按最終實作修訂）

- [x] 250ms debounce、實際 AbortController、generation guard 及保留現有列表已完成。
- [x] 控制時鐘證明連續輸入只送最後查詢，清空搜尋立即載入。
- [x] 排序、定位、失敗保留、版本 409、快速查詢、390px 與鍵盤回歸通過。

## 不在範圍

Server 端 TOC 搜尋或排序（ER-004 已完成）、全文搜尋（CR-009）、TOC 版本計算（CR-006）。

## 依賴

ER-004 的目錄搜尋與排序已交付；本票在其上補前端節流。

## 實作提示

- 可以用 `useDeferredValue` 降低優先級，但它不是 debounce；若要嚴格減少請求，使用 `setTimeout` 250ms 並在 cleanup 清除。
- `AbortController` 要用於 `getToc` 的 fetch；若 API client 未支援 signal，先加參數，勿只在 component 忽略 response。
- 保留 `requestId` 作第二層保護，但不要把它當成取消機制。
- `locate()` 會 `setQuery('')` 並更新 location，這類明確操作應繞過 debounce。

## 審查依據

- `apps/web/src/reader/TableOfContents.tsx:34-60`：`load` dependency 與 `[load]` effect
- `apps/web/src/reader/TableOfContents.tsx:54-60`：清空 entries 與重新載入

## 2026-10-19–20 實作結果

250ms debounce、實際 abort、保留既有列表及明確操作立即生效已實作，包含控制時鐘的請求數測試。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
