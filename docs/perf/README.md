# 效能量測結論與索引決策（M7 Phase 3.4）

**量測日期：2026-10-03｜資料：`baseline.md`（5,000 作品）＋ 20,000 作品對照。**

`baseline.md` 由 `pnpm perf:measure --md` 產生，是**資料**；本檔是**結論與決策**，
不會被腳本覆寫。dev-plan §16A-C 要求「先量測再決定」、§16 要求「日後有實際瓶頸才加入」，
所以以下每個決定都附量測依據。

---

## 1｜量測到什麼

兩個規模的 p50（ms，runs=20／10；直接驅動 HTTP handler，含 DTO 與繁簡變體查詢）：

| 查詢 | 5,000 作品 | 20,000 作品 | 倍率 |
| --- | --- | --- | --- |
| 書庫首頁（無篩選） | 4.8 | 10.7 | 2.2× |
| 分類 OR（2） | 2.9 | 6.2 | 2.1× |
| 標籤 ANY（3） | 3.3 | 5.3 | 1.6× |
| 標籤 ALL（3） | 9.1 | 8.7 | 1.0× |
| 標籤 ALL＋分類＋狀態 | 7.3 | 6.1 | 0.8× |
| **關鍵字（短，2 字）** | **21.3** | **38.1** | **1.8×** |
| **關鍵字＋標籤 ALL** | **37.3** | **72.8** | **2.0×** |
| count（無篩選） | 1.3 | 5.1 | 3.9× |
| count（關鍵字＋標籤 ALL） | 29.4 | 63.5 | 2.2× |
| 閱讀器：作品 metadata | 0.7 | 0.9 | 1.3× |
| 閱讀器：目錄一頁（200） | 0.9 | 1.5 | 1.7× |
| 閱讀器：單章內容 | 1.1 | 1.5 | 1.4× |

資料量 4 倍，成本約 2 倍——次線性，因為多數條件在 `works` 的單次掃描內解決。

## 2｜最重要的一項：閱讀路徑不隨書庫成長

**閱讀器三條路徑在 4 倍資料下都維持 ~1ms**，因為它們全部走索引
（`release_items (release_id, editorial_position)` 的唯一索引、revision 主鍵）。
書庫變大不會讓讀者翻頁變慢。這是最該保護的性質，任何改動若讓這三行變慢就是回歸。

## 3｜唯一的實際瓶頸：前綴萬用字元 ILIKE

關鍵字查詢是唯一明顯偏慢的一組。計劃顯示原因（`baseline.md`
「keyword ILIKE across title/author/taxonomy」）：

```
Seq Scan on works w
  Filter: visibility = 'public' AND (title ~~* '%風起%' OR author ~~* '%風起%' OR …)
  Rows Removed by Filter: 4563
```

`%foo%` 兩端萬用字元，btree 索引無法使用，只能全表掃描。
分類／標籤子查詢本身很便宜且已用到既有反向索引
（`work_categories_reverse_idx`、`work_tags_reverse_idx`，計劃中可見）。

API 數字（21ms）高於 SQL（10.7ms）的差額來自繁簡變體：一個關鍵字會展開成
原文＋轉換後兩組 pattern，等於 4 個 ILIKE 條件。這是 §16 要求的繁簡等價查詢，
不是浪費。

## 4｜決策：**現在不加 pg_trgm**

**不加**。理由：

1. Beta 的書庫規模是數百到數千部，不是 20,000。在 5,000 部時關鍵字 p95 為 24ms，
   以手機閱讀為主的產品完全可接受。
2. `pg_trgm` 是額外 extension 依賴＋migration，而 CJK 的 trigram 是三字視窗，
   索引體積大、對短查詢（2 字）效果本來就有限——§16A-C 明文警告「不把 PostgreSQL
   預設搜尋視為已解決中文斷詞」，換成 trigram 一樣不等於解決斷詞。
3. §16 定了「日後有實際瓶頸才加入」。現在加，就是為一個還不存在的問題付出複雜度。

**不加索引，不是「不管」。** 以下是明確的觸發條件，任一成立就回來處理：

| 觸發條件 | 動作 |
| --- | --- |
| 已上架作品數 > 20,000 | 重跑 `pnpm perf:measure`，比對計劃是否仍是 Seq Scan |
| 關鍵字查詢 p95 > 150ms | 加 `pg_trgm` GIN 索引於 `works.title`、`works.author`、`categories.display_name`、`tags.display_name`；加完必須重跑短（2 字）與長（6 字）兩種中文 query |
| 閱讀器三條路徑任一 p50 > 5ms | 視為回歸，先查計劃是否改走 Seq Scan，不要直接加索引 |

## 5｜已確認不需要的索引

計劃顯示這些查詢已走到既有索引，**不要再加重複索引**（§16A-C：「PK／UNIQUE
已建立的索引不重複加」）：

- 目錄分頁 → `release_items_position_uq (release_id, editorial_position)`
- 標籤／分類反向查詢 → `work_tags_reverse_idx`、`work_categories_reverse_idx`
- 章節修訂讀取 → `chapter_revisions` 主鍵

## 6｜量測的限制（不要過度解讀）

- 單一 process、本機 Docker PostgreSQL、無併發負載。**這不是壓測**，沒有回答
  「50 個同時使用者會怎樣」。
- 合成資料的標題／作者是規則產生的，字元分布不等於真實中文書名。
- 合成章節**沒有 storage 物件**，所以沒有量測正文讀取的 I/O。
- `work_mem`、`shared_buffers` 是 Docker 預設，生產環境需另行調整並重測。

## 7｜重跑方式

```bash
pnpm perf:seed                                   # 5,000 作品（含 ANALYZE）
pnpm perf:measure --md > docs/perf/baseline.md   # 重新產生資料檔
pnpm perf:seed --works=20000                     # 規模對照
pnpm perf:seed --clean                           # 清掉合成資料
```

**清掉前 `pnpm maintenance` 的缺檔整合性報告會包含合成資料**（合成章節沒有
storage 物件），不要把它當成真實的資料遺失。
