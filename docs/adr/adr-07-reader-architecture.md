# ADR-07｜生產閱讀器架構：Canonical Chapter Renderer

日期：2026-10-01｜狀態：已採納｜取代 dev-plan §23 中「M0 閱讀引擎擇一（epub.js vs foliate-js）」待辦

## 背景

M0 以雙引擎 POC（epub.js 0.3.93 自建、foliate-js commit `78914aef`）驗證了 EPUB 閱讀可行
性，原計畫在真機 L3 後擇一作為生產渲染核心。同時，M2–M4 已建立完整的 canonical 內容管
線：source TXT/EPUB → parser → staged chapters → canonical chapters → 不可變 chapter
revisions → 私有 storage（body 為 `\n\n` 連接的純文字段落，TXT 與 EPUB 一致）。

問題：生產閱讀器應該渲染什麼？

## 選項

### A. Canonical chapter renderer（採用）

Server 回傳 canonical 章節內容（純文字段落陣列），前端以自有 React 元件渲染：
排版、分頁、捲動、章節導覽、段落錨定（`data-paragraph-index`）、繁簡轉換全部由自己控制。

### B. EPUB 引擎渲染器（不採用）

以 epub.js 或 foliate-js 為生產核心。引擎消費的是 EPUB package（spine/CFI/OPF），而
canonical 模型裡不存在這些概念——要嘛讀取時即時合成 EPUB（昂貴且造作），要嘛 TXT 走另
一條渲染路（形成「TXT 讀取器＋EPUB 讀取器」兩套體驗，正是本階段要避免的）。

## 比較

| 維度 | A. Canonical renderer | B. EPUB 引擎 |
| --- | --- | --- |
| TXT／EPUB 一致性 | 同一 body 契約，天然一致 | TXT 需合成 EPUB 或第二套路徑 |
| 段落定位 | `chapter_id+revision_id+paragraph_index` 直接映射 DOM | CFI/location 模型與 canonical 位置契約衝突，需雙向轉換 |
| 修訂相容性 | revision 只換 body，段落索引照常回錨 | 引擎內快取/書籤以 EPUB 結構為鍵，revision 前移後語義不明 |
| 依賴穩定性 | 無新依賴 | epub.js npm 版停在 0.2.15（2014），upstream 須自建 fork；foliate-js 不在 npm、API 未穩定（M0 已鎖 commit） |
| iOS/Android 行為 | 標準 DOM 文字流，瀏覽器原生行為 | iframe 隔離層（epub.js）在 iOS Safari 歷來問題多（M0 POC 已知長按選字/慣性捲動風險） |
| 繁簡轉換 | 對段落字串逐段轉換，段落數不變 | 引擎 iframe 內 textContent 層級轉換會抹平行內標記（M0 已知限制） |
| 維護成本 | 自有 ~數百行排版/分頁碼 | 引擎升級、fork 維護、API 變動追蹤 |

## 決策

採用 **A. Canonical chapter renderer**。匯入格式只是 ingestion 格式；閱讀器只消費
canonical 模型：`work → chapter → head revision → 段落陣列`。閱讀位置契約維持
`chapter_id + revision_id + paragraph_index`，頁碼永不作為 canonical 進度。

理由的核心：canonical body 已是單一純文字段落序列，任何 EPUB 引擎的價值（解析包、
spine、CFI）在這條管線裡都不存在；引入引擎只會增加一層與資料模型不合的抽象。

## M0 POC 的教訓與遺產

- 兩引擎皆能載入、分頁、段落錨定（headless L1 通過），但 L3 真機比較從未完成——本
  ADR 使該比較**失去必要性**，原「epub.js vs foliate-js 擇一」需求由本文件取代。
  真機驗證義務轉移到 M5 生產閱讀器的 L3 清單（見 `docs/adr/l3-device-checklist.md`）。
- POC 的繁簡轉換/定位在 textContent 層級，會抹平行內標記——canonical 純文字模型使
  「逐 text node 轉換」簡化為「逐段落字串轉換」，段落邊界由 `\n\n` 保證。
- `m0/reader-poc/`（含 vendored epub.js/foliate-js）與 smoke 測試**保留不刪**，僅作
  歷史參考；Playwright 冒煙測試模式由 M5 瀏覽器測試沿用。

## 生產是否保留 epub.js / foliate-js

不保留。生產閱讀器零閱讀引擎依賴；僅依賴 React＋opencc-js（檢視期轉換，與 M0 POC
同一實作）。

## 遷移影響

無遷移——生產閱讀器（M5）是全新前端模組，不從任何引擎遷移。

## 已知代價

- 分頁（CSS multi-column）、大字號重排、跨瀏覽器行為由我們自己負責（見 §11 測試）。
- 若未來 canonical 模型保留 EPUB 語義結構（圖片、註腳、行內標記，現行 parser 已拍平
  為純文字），需在 renderer 內擴充 sanitize 後的安全節點渲染，屆時仍不需要 EPUB 引擎。
