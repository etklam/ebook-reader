# RV-004｜閱讀器 head 未跟隨語言切換

- 嚴重度：中
- 優先級：P2
- 工作量：小
- 類型：AFK
- 狀態：implemented-local（2026-10-24）

## 要做的事

`ReaderPage` 寫 head 的 effect 缺少 `locale` 依賴，切換介面語言後閱讀器的 tab 標題與 `og:locale` 會停留在舊語言，直到換章才更新。`WorkDetailPage` 的同一段邏輯已正確處理。

## 分析

`apps/web/src/reader/ReaderPage.tsx:318` 的依賴陣列是 `[work, chapter]`。但 effect 內：

- `:309` 的 `title(...)` 會呼叫 `head.ts:38` 的 `site()`，即 `t('書庫')`；
- `applyHead` 本身（`head.ts:90`）會讀 `currentLocale()` 去寫 `og:locale`。

兩者都隨語言改變，所以切換語言後閱讀器的 head 會過期。`apps/web/src/catalog/WorkDetailPage.tsx:82` 的依賴是 `[work, locale]`，並附註釋「`locale` 是真實依賴：標題與描述會被翻譯」——即同一個問題在作品頁已被識別並處理，閱讀器漏了。

為何 lint 捉不到：`eslint.config.js:13-14` 已開啟 `react-hooks/exhaustive-deps: 'error'`（CR-010 的成果），但 `locale` 並非在 effect 內直接出現的識別碼 —— 它藏在 `title()` 與 `applyHead()` 這兩個 module-level 函式對模組狀態的讀取之中。這類「經由 module singleton 讀取 reactive 值」的依賴，exhaustive-deps 原則上無法偵測。

因此把 `locale` 加進依賴陣列只是治表。更穩固的做法是讓這個隱藏依賴變成顯式：

- **A（小）**：`ReaderPage` 加 `useLocale()` 並把 `locale` 放進依賴陣列。與 `WorkDetailPage` 一致，兩行改動。
- **B（較穩）**：`applyHead` 不再自行讀 `currentLocale()`，改由呼叫端把 locale 當參數傳入；`site()`／`title()` 同樣改成接受 locale。這樣 lint 就能看見依賴，將來新增的呼叫端不會重犯。

建議做 A 止血，並在同票內評估 B 的影響面（目前只有三個呼叫端：`App.tsx:141`、`WorkDetailPage.tsx:72`、`ReaderPage.tsx:308`，所以 B 的成本其實很低）。

## 驗收條件

- [ ] 在閱讀器內切換介面語言後，`document.title` 的站名部分與 `og:locale` 立即更新，無需換章。
- [ ] 有測試覆蓋此行為（可併入 RV-005 的 `head.ts` 測試，或 `apps/web/e2e/i18n.spec.ts`）。
- [ ] 若採 B：`applyHead` 不再隱式讀取模組狀態，三個呼叫端一併更新，並確認 `react-hooks/exhaustive-deps` 能對漏傳 locale 報錯。
- [ ] `pnpm lint`、`pnpm typecheck` 通過。

## 不在範圍

i18n 的 URL 策略（兩種語言共用同一條 URL 是現行設計，見 `apps/web/src/i18n/locale.ts:1-3`）。

## 依賴

無；與 RV-005 共用 `head.ts`，建議一併排程。

## 實作結果（2026-10-24）

採用方案 A（兩行）。`ReaderPage` 加 `useLocale()`，`locale` 進 head effect 的依賴陣列，並附註釋說明為何 `exhaustive-deps` 看不見它。沒有做方案 B（把 locale 改成 `applyHead` 的參數）—— 三個呼叫端本來就不多，但 B 會改動 `head.ts` 的公開形狀，而 RV-003／RV-005 同時在動同一個檔案，風險不值得。B 仍是將來值得做的收斂。

驗證：`pnpm lint`、`pnpm typecheck` 通過。`apps/web/e2e/seo.spec.ts` 的 `the head follows a language switch` 覆蓋此行為（在作品頁），**但未執行**。閱讀器本身的語言切換沒有自動覆蓋 —— 要 mock 整個 reader 的 API，或用已 seed 的 stack，兩者都超出本票範圍。

## 審查依據

- `apps/web/src/reader/ReaderPage.tsx:302-318`
- `apps/web/src/catalog/WorkDetailPage.tsx:72-82`
- `apps/web/src/lib/head.ts:38`、`:41-44`、`:90`
- `eslint.config.js:11-15`
