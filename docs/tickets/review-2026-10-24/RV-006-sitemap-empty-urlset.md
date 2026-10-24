# RV-006｜sitemap 空 urlset 與 count／join 不一致

- 嚴重度：低至中
- 優先級：P3
- 工作量：小
- 類型：AFK
- 狀態：implemented-local（2026-10-24）

## 要做的事

`sitemap.ts` 的註釋聲明「空的 `<urlset>` 等於遞一份無效 XML 給 crawler，所以不廣告空頁」，但測試卻把「超出範圍的頁回 200 + 空 urlset」當成預期行為，而且 index 的計數與分頁 query 不完全等價，存在真正產生空尾頁的路徑。本票要令三者一致。

## 分析

### 矛盾

- `server/src/routes/sitemap.ts:108-109`：「No rows means no page: the schema requires a urlset to hold at least one `<url>`, so advertising an empty page would hand a crawler invalid XML.」
- `server/src/routes/sitemap.test.ts:116-117`：「a page past the end is a valid, empty page rather than an error」，並 assert `/sitemap-works-99.xml` 回 200。

兩者都說得通（index 不廣告空頁；直接請求舊頁不應 500），但沒有人決定過「空 urlset 本身」是否可接受。目前的結論被測試固定成「可接受」，與檔頭註釋相反。

### 真正會產生空尾頁的路徑

index 的計數（`:99-107`）與章節分頁 query（`:167-177`）不是同一個 join：

| | 計數 query | 分頁 query |
| --- | --- | --- |
| `release_items` | ✓ | ✓ |
| `work_releases` | ✓ | ✓ |
| `works`（`active_release_id = ri.release_id`、`visibility='public'`）| ✓ | ✓ |
| `chapters`（`c.id = ri.chapter_id`）| ✗ | ✓ |

分頁 query 多一個 `join app.chapters c`。只要有一行 `release_item` 指向已不存在的 `chapters` 列，計數就會大於實際可輸出的 URL 數。當這個差額剛好跨過 `PAGE_SIZE = 10_000` 的邊界，index 就會廣告一頁，而該頁輸出零條 `<url>` —— 正是 `:108-109` 說要避免的情況。

作品側的 query 對 `visibility='public' and active_release_id is not null`（計數）與 `join work_releases r on r.id = w.active_release_id`（分頁）是等價的，沒有同樣問題。

### 修正方向

兩步，都很小：

1. 令計數與分頁 query 使用同一組 join（計數補上 `join app.chapters`），消除差額來源。
2. 決定空 urlset 的處理並讓註釋、程式與測試一致。建議：保留 200（直接請求舊頁不該是錯誤），但輸出一個語法上有效的空 `<urlset>`（sitemaps.org schema 實際允許零個 `<url>`，`:108-109` 的「invalid XML」說法偏嚴），並把註釋修正為「不廣告空頁是為了不浪費 crawler 的請求」，而非正確性理由。

另可順帶確認：`release_items` 與 `chapters` 之間是否有 FK／`on delete` 約束。若有 FK 保證不會出現孤兒 `release_item`，則第 1 步只是防禦性收斂，應在票內註明理由而非假裝修了一個不存在的 bug。

## 驗收條件

- [ ] 章節 index 計數與章節分頁 query 使用同一組 join，並有測試證明兩者對同一組資料得出一致的頁數。
- [ ] 空 urlset 的處理方式已決定；`sitemap.ts` 的註釋、實作與 `sitemap.test.ts:116-117` 三者一致。
- [ ] 已查明 `release_items → chapters` 是否存在 FK 約束，結論寫入票內。
- [ ] `pnpm test` 與 `pnpm --filter server test:e2e` 通過。

## 不在範圍

改用 keyset 分頁（`:136-141` 已論證 offset 在 crawler 情境下是刻意選擇）。

## 依賴

無。

## 實作結果（2026-10-24）

查明結果改變了做法：`release_items.chapter_id` 與 `.revision_id` 都是 `notNull` 並帶 `on delete no action` FK（`0004_m6.sql:131`），所以孤兒 `release_item` 不可能存在，count 與分頁 query 的 join 差異**不會**產生空尾頁。因此沒有補那個 join —— 加一個 FK 已經保證的 join 只是雜訊。改為在 count query 上方寫明這個等價關係由哪兩條 FK 保證，以及 FK 若放寬會發生什麼。

矛盾的那一半照修：`:108` 原本稱空 `<urlset>` 是「invalid XML」，這不準確（sitemaps.org schema 允許零個 `<url>`）。註釋改為說明不廣告空頁的真正理由是不浪費 crawler 的請求，而直接請求超出範圍的頁仍然回 200 加一個有效的空 urlset。`sitemap.test.ts:116-117` 的既有預期因此變成與註釋一致，不需要改動。

## 審查依據

- `server/src/routes/sitemap.ts:99-119`、`:136-141`、`:164-177`
- `server/src/routes/sitemap.test.ts:112-118`
