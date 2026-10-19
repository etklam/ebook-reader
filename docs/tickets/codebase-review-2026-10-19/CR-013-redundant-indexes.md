# CR-013｜移除重複索引

- 嚴重度：低
- 優先級：P3
- 工作量：小
- 類型：AFK
- 狀態：implemented-local

## 要做的事

Schema 有兩個索引與既有 constraint／primary key 的前綴重複：

- `chapters_work_position_idx` 與 `chapters_work_position_uq` 都是 `(work_id, editorial_position)`；
- `user_follows_user_idx` 是 `(user_id)`，而 primary key 是 `(user_id, work_id)`，已可服務以 `user_id` 開頭的查詢。

重複索引會增加每次 INSERT／UPDATE 的寫入成本與磁碟用量，對高頻的章節排序、跟隨操作沒有好處。先以實際查詢計畫確認，再開 migration 移除。

## 驗收條件（按最終實作修訂）

- [x] 實際索引定義／本機使用統計、5,000 章規模寫入及 EXPLAIN 原始數據已保存。
- [x] 移除後 TOC／定位使用 unique index、follows 使用 PK，沒有對照查詢 seq scan 回歸。
- [x] 0015 只 drop 兩個重疊 indexes，保留 constraint；db:verify 及相關 DB regressions 通過。
- [x] 重建 indexes 的 rollback 與非尖峰部署建議已記錄。
- [ ] Production idx_scan 長期觀察與 rollout 時段安排完成。

## 不在範圍

新增搜尋索引（CR-005）、調整 primary key、分割資料表、PostgreSQL 參數調校。

## 依賴

無。建議在 CR-005／CR-006 的查詢變更穩定後再做，避免 EXPLAIN 比較被其他改動干擾。

## 實作提示

- Deferrable unique constraint 仍會建立 unique index，通常可用於讀取；先確認版本與實際計畫，不要假設它一定不被使用。
- `user_follows` 的 `(user_id, work_id)` primary key 可服務 `where user_id = ?`；若查詢是按 `followed_at` 排序，這個索引未必足夠，需看實際 SQL 再決定。
- 不要只憑 schema 外觀 drop；以 `pg_stat_user_indexes.idx_scan` 與 query plan 佐證。
- 若使用 Drizzle migration，確認 drop index 的 SQL 與既有 migration 命名風格一致。

## 審查依據

- `server/src/db/schema.ts:162-167`
- `server/src/db/schema.ts:414-422`

## 2026-10-19–20 實作結果

先以實際 PG 定義、暫存 fixtures、EXPLAIN 與寫入比較確認，再新增 0015 migration 移除兩個重疊 index；unique／PK 保留。rollback 與原始計畫已記錄。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
