# CR-002｜修正閱讀器上一頁／下一頁切章

- 嚴重度：高
- 優先級：P1
- 工作量：小
- 類型：AFK
- 狀態：implemented-local

## 要做的事

原程式有兩項缺口：內部切章使用 replaceState，沒有逐章 history entry；外部 SPA／瀏覽器 route 改變時，ReaderPage 也不回應 initialChapterId，可能將 URL replace 回目前章節。因此原先「內部第 1 章 → 第 2 章 → 上一頁回第 1 章」並非原程式自然建立的 history 流程。本次明確採用內部切章 pushState，並處理外部章節／hash 改變。

本票要令 reader 正確回應 `initialChapterId` 的外部變化（瀏覽器 back／forward、SPA 深鏈、其他頁面導航），同時避免初次載入重複請求。

## 驗收條件（按最終實作修訂）

- [x] 內部切章建立 history；同書 back／forward、單次章節請求、回到非章首位置通過瀏覽器回歸。
- [x] 同章段落 hash、重複開同一深鏈、直接書籤入口可正確定位。
- [x] work/account 初始化與 chapter route 分開，不因每次切章重新合併設定。

## 不在範圍

ReaderPage 整體重構（見 CR-010）、進度同步（CR-004）、書內搜尋按鈕（CR-009）。本票只修章節導航與 URL 一致性。

## 依賴

無，可獨立開始。建議在 CR-010 之前完成。

## 實作提示

- 保留 mount effect 負責第一次載入與會員資料；另加 effect 監察 `initialChapterId`，若與目前章節不同才呼叫 `loadChapter`。
- 用 ref 記錄已載入章節，避免 effect 在初次 render 時與 mount effect 重複執行。
- 不要把 `initialChapterId` 直接加入現有 mount effect 的 dependency；那會令 reloadToken、會員載入與章節切換互相重跑。
- 現有 URL sync effect 需要區分「reader 自己換章」與「外部 history 導航」。

## 審查依據

- `apps/web/src/App.tsx:90-92`：`ReaderPage key={route.route.workId}`
- `apps/web/src/reader/ReaderPage.tsx:240-276`：初始載入 effect 的 deps
- `apps/web/src/reader/ReaderPage.tsx:279-289`：URL sync effect
- `apps/web/src/reader/ReaderPage.tsx:285-289`：目前章節與 prop 不同時 replaceState

## 2026-10-19–20 實作結果

內部切章新增 pushState 歷史，work/account 初始化與 route/hash 導航分開。新增 back/forward、同章 hash、重複深鏈及單次請求瀏覽器回歸。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
