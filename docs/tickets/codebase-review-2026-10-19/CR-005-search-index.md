# CR-005｜量測並改善書內全文搜尋的整本掃描

- 嚴重度：中高
- 優先級：P2
- 工作量：中至大
- 類型：AFK
- 狀態：implemented-local

## 要做的事

ER-012 已把書內搜尋改成「找到本頁與下一頁所需命中即回傳」，但明確保留一個限制：稀疏或無命中查詢仍會掃完整本。目前每個章節的正文要由 storage 讀取，`findChapterMatch()` 再在程序內做 normalize 與比對；5,000 章 × 100KB 的書，單次無命中搜尋可能讀取約 500MB 檔案。

本票先量測真實正文規模下的成本，再決定是否建立發布版搜尋索引。目標不是重做 ER-012 的游標或前端分頁，而是避免每次查詢都線性掃描所有正文。

## 驗收條件（按最終實作修訂）

- [x] 5,000 × 100KiB 真正文 baseline／after、I/O bytes、p50/p95、併發 1/4 原始數據已保存。
- [x] 依門檻採完整 immutable object 候選索引，不截斷正文；matcher／cursor／段落／授權契約保留。
- [x] Unicode、繁簡 variants、損壞／缺失 sidecar、短詞、title-only hit 及原搜尋回歸通過。
- [x] 索引自動建立、串行 backfill、刪除及 rollback 文件已完成。
- [ ] Production corpus 的飽和率、短詞負載及實際儲存吞吐量另作觀察，不以本機重複文字 fixture 代表。

## 不在範圍

外部搜尋服務、語意搜尋、跨作品搜尋、即時 index on write 的複雜 pipeline。ER-012 的游標契約與前端「還有更多」行為不改。

## 依賴

- ER-012 已完成；本票只處理其列出的剩餘限制。
- 需要真實正文與 storage 的效能環境；不可只用 metadata fixture。

## 實作提示

- 中文用 `pg_trgm` 未必完美，但對「書內找句子」通常比每次讀檔好；先量測再選型。
- 索引鍵用 `revision_id`，因為 release item 指向不可變 revision；不要用會變動的 chapter head。
- 保留現有搜尋 API 的 cursor／filter fingerprint，索引只是候選章節來源，不要改 response shape。
- 不可只索引正文前 N KB：會漏掉後段命中。採候選索引亦必須無假陰性，缺失或失效時回完整 matcher。

## 審查依據

- `server/src/routes/search-export.ts:99-125`：逐批讀取 body 的 scan
- `server/src/search/chapter-search.ts`
- `docs/tickets/reader-improvements/ER-012-search-pagination.md`：已知的無命中全掃限制
- `docs/perf/reader-improvements-2026-10-15.md`：現有搜尋 I/O 基準

## 2026-10-19–20 實作結果

大型正文量測超門檻後，採 immutable object 的完整正文 Bloom 候選索引，不使用 SQL index 或正文截斷。候選仍經原 matcher；短詞／損壞／缺失／飽和索引 fallback，最壞情況仍可全掃。前後測量見 verification.md。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
