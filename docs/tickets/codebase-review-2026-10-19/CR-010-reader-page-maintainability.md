# CR-010｜加入 react-hooks lint 並分拆 ReaderPage

- 嚴重度：中
- 優先級：P3
- 工作量：中至大
- 類型：AFK
- 狀態：implemented-local

## 要做的事

`apps/web/src/reader/ReaderPage.tsx` 已達 854 行，集中處理章節載入、進度同步、TTS、鍵盤、scroll 還原、設定與 UI。與此同時，root ESLint 只有 `typescript-eslint`，沒有 `eslint-plugin-react-hooks`，所以 CR-002 這類 missing dependency 不會在 CI 被發現。

本票分兩階段：

1. 先加 hooks lint，令同類問題不能再靜默通過；
2. 再把 reader 的獨立職責抽成 hooks／模組，提升可測試性。

## 驗收條件（按最終實作修訂）

- [x] root 已安裝 hooks plugin，rules-of-hooks/exhaustive-deps 為 error，CI pnpm lint 覆蓋。
- [x] 既有 violations 修正；三處 counter cleanup 只有附理由的單行例外。
- [x] 抽出入口／導航、進度同步、鍵盤三組 hooks，ReaderPage 行數下降且原 DOM/ARIA 保留。
- [x] 單元、typecheck、lint、build、reader browser 及既有定位／預載 performance scripts 通過。

## 不在範圍

Reader UI 重新設計、CSS 重寫、狀態管理庫引入、把 reader 改成 server component。本票只做 lint 防護與職責拆分。

## 依賴

- CR-002（章節導航）與 CR-004（同步序列化）先完成，避免在同一段 effect 上反覆衝突。
- 若 CR-009 已改動 reader 導航，亦應先合併。

## 實作提示

- 先加 lint 並修到 green，再做重構；否則重構期間的 violations 會混在一起。
- 適合抽出的邊界：`useChapterLoader`、`useProgressSync`、`useSpeechPlayback`、`useReaderKeyboard`、`useScrollRestore`。
- 不要把 React state 全部搬去 context；先以同檔案 hooks 降低風險，再考慮跨檔案。
- 用現有 e2e 作行為護欄，重構時不要順便改視覺或互動。

## 審查依據

- `apps/web/src/reader/ReaderPage.tsx`：854 行
- `eslint.config.js`：只有 typescript-eslint
- `apps/web/src/reader/ReaderPage.tsx:240-276`：CR-002 的 missing dependency 實例

## 2026-10-19–20 實作結果

hooks lint 為 error；抽出入口／導航、同步、鍵盤三組 hooks。ReaderPage 854 → 777 行。既有 counter ref cleanup 只保留三個有理由的局部 lint 例外。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
