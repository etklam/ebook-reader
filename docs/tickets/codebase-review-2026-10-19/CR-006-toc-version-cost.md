# CR-006｜移除目錄每次請求的全書版本 hash

- 嚴重度：中
- 優先級：P2
- 工作量：中
- 類型：AFK
- 狀態：implemented-local

## 要做的事

目錄 API 在 head（草稿）模式下，每次請求都計算：

```sql
md5(string_agg(row(base.*)::text, ',' order by "editorialPosition"))
```

即把全書章節 row 轉成 text、排序、串接再 hash。這個成本與 page size 無關，5,000 章的書每開一次目錄都要付一次；`row_number() over (order by ...)` 亦會掃過整個 base set。

`works.editVersion` 會在匯入回復時回退並重用，不能直接作 TOC generation。採獨立 `works.tocVersion`，由 statement trigger 在章節變動時產生新 UUID，避免版本重用。Release 本身不可變，沿用 `activeReleaseId`。

## 驗收條件（按最終實作修訂）

- [x] 移除 head 全書 md5/string_agg；改獨立不可重用 UUID generation，公開版仍用 release ID。
- [x] statement triggers 覆蓋章節 insert/update/delete，包含批次、排序、head revision 切換及匯入回復。
- [x] 5,000 章計畫／p50/p95、版本不重用、既有 TOC 搜尋／排序／分頁／409 測試通過。
- [x] migration、schema、snapshot 一致，db:generate 無額外差異。

## 不在範圍

TOC keyset pagination、前端目錄 UI、搜尋索引（CR-005）。所有 canonical 章節 mutation 由資料庫 trigger 覆蓋，而不是靠每個應用路徑記得更新版本。

## 依賴

無，可獨立開始。需先盤點所有 head mutation 是否都會 bump `editVersion`。

## 實作提示

- `server/src/routes/reader.ts:172-176` 是主要熱點。
- `server/src/routes/admin-chapters.ts:232,295,374` 與 `server/src/import/apply-incremental.ts:417-418` 已會 bump；合併／拆分／排序路徑要逐一確認。
- Version 字串維持 opaque 相等比較（例如 `head:<generation-uuid>`、`<release-uuid>`），前端只做相等比較，不需要解析。
- 移除 hash 後，`base` CTE 仍需要正確的 release／head 分流；不要為了省成本而改變可見性。

## 審查依據

- `server/src/routes/reader.ts:167-193`
- `server/src/db/schema.ts:67`：`works.editVersion`
- `server/src/routes/search-export.ts:85`：已有的 editVersion 用法
- `server/src/routes/admin-chapters.ts:232,295,374`
- `server/src/import/apply-incremental.ts:417-418`

## 2026-10-19–20 實作結果

採獨立 UUID toc_version + chapters statement triggers，沒有直接沿用會回退／重用的 editVersion。公開版保持 release ID。5,000 章 query plan 與 generation 回復測試已完成。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
