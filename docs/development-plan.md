# 後續開發計劃（M7 → Beta）

**建立日期：2026-10-03｜更新：2026-10-03｜狀態：Phase 2–4 完成；Phase 1 待執行（需人手）。**

本文件是 M6 完成、M7 安全／正確性回歸完成（commit `ac31e0f`）之後的前瞻計劃。
規格真相仍是 `dev-plan.md`（v1.3）；**實際進度真相仍是 `dev-plan.md` §26**，本文件只排
順序與驗收，不取代 §26 的進度紀錄。

> 排序原則：**先驗證無法由程式自證的假設，再改會污染資料模型的東西，最後才做打磨。**
> 反過來做的代價是重工，不是延誤。

---

## 現狀摘要

| 項目 | 狀態 |
| --- | --- |
| M0–M4（POC、基礎工程、匯入、增量／插章、覆蓋／冪等／回復） | 完成 |
| M5（手機閱讀器） | 實作完成，**真機 L3 未執行——不得宣稱驗收** |
| M6（發布、公開書庫、taxonomy、會員狀態） | 實作完成 |
| M7（Beta hardening） | **程式與文件完成**：Phase 2／3／4 全部落地（見 §26）。**唯一未完成是 Phase 1 真機 L3** |

自動化測試基線（2026-10-03，Phase 4 完成後）：lint／typecheck 乾淨、
unit 89/89（server 70＋web 9＋m0 10）、server e2e 75/75、瀏覽器 12/12、
migration 0000→0007＋`db:verify` 通過、還原演練 8/8。
**Playwright 通過 ≠ 真機通過**（§22A）。

---

## Phase 1｜真機驗證閱讀器（**唯一未完成項｜阻塞上線｜需人手**）

**目標：** 執行 `docs/adr/l3-device-checklist.md` 的 18 項，在實體 iOS Safari 與
Android Chrome 上各跑一次。

**為何排第一：** ADR-07 讓生產閱讀器變成自家 canonical renderer，沒有 library 後備。
第 4／5／6／9 項（改字號、繁簡、轉屏、模式切換後回錨同一段落）與第 13 項（safe-area）
是最可能在真機上失敗、而且修起來會動到 `reader/position.ts`、`reader/pagination.ts`
的項目。在這之上再疊一個月的功能，失敗時要重工的面積只會更大。

**我已準備（不需你動手）：**

- `pnpm dev:lan` — 把 vite dev server 綁到 LAN（預設仍只綁 loopback），手機可直連
- `pnpm --filter server seed:l3` — 以真實匯入管線（上傳→worker→commit→publish）
  建三部已發布作品，覆蓋全部 18 項所需素材
- checklist 內補上逐項操作步驟與實際網址，填表即可

**你要做的：** 兩部手機各跑一次，把結果填進 checklist 的表格；失敗項附截圖與重現步驟。

**狀態：未執行。** 其餘所有階段都已完成，所以這是 Beta 之前唯一剩下的工作，
也是唯一我無法代替執行的工作。

**驗收：** checklist 兩欄填滿並記錄日期／裝置／OS／瀏覽器版本。任何失敗項轉為修復工作，
修完重跑該項。**在此之前 M5 與 M7 都不算驗收通過。**

---

## Phase 2｜補齊內容保真度（ADR-08：圖片／註腳／資源）— ✅ 完成 2026-10-03

**目標：** canonical 內容模型保留資源，解除 IMP-17 的封鎖。

**問題：** 現行 EPUB 解析在 M2 即拍平為純文字——圖片不映射、list 不萃取、註腳消失。
資源層根本不存在，所以 IMP-17（「同正文但圖片／註腳目標有改須判為修訂」）無從實作，
ADR-08 明文禁止在管線補齊前標記通過。

**工作：**

1. EPUB parser 萃取資源（圖片、註腳目標、內部連結），保留來源 href／fragment 對照
2. 不可變 `chapter_revision_resources` 關聯（revision 不可變 → 資源引用一併凍結）
3. `revision_hash` 納入資源引用：正文沒變但圖片／連結變了也要判為 modified
4. 閱讀器安全渲染資源（沿用 ADR-07 的 sanitize 契約，不引入 HTML 解析回正文路徑）
5. 資源物件納入 storage adapter 與發布快照的完整性驗證

**為何排第二、不能更晚：** 這會改 canonical 內容模型。**在它落地之前匯入的作品，
都要重新匯入才會有圖片。** 現在做＝不需要遷移；載入 Beta 內容之後做＝要對真實內容重跑
匯入與發布。

**驗收：** ✅ 全部達成。IMP-17 通過（RES-06）；含圖片與註腳的 EPUB 完整到閱讀器；
只改圖片目標被分類為 `modified`；既有回歸全過（e2e 75/75）。

**實作後的重要修正：** IMP-17 的真正機制是 body 內的 marker（hash 在正文裡，
所以 `body_compare_hash` 本身就會變），不是 resource 表。`resourceDigest` 是第二道
獨立檢查並讓 `revision_hash` 符合 §10 定義。程式註解已如實說明，不誇大。

**仍不在範圍：** 互動式註腳（彈出層／回跳）、SVG、list 萃取、一個 XHTML 多章錨點拆分。

---

## Phase 3｜收完 M7 的正確性與工程項 — ✅ 完成 2026-10-03

### 3.1 Cursor 分頁（正確性缺陷，非偏好）

`/api/works` 目前用 `limit`／`offset`，`CatalogPage.tsx` 以 append 方式「載入更多」。
§03A-F 指定 `cursor=<opaque-cursor>` 且綁定正規化 filters＋sort；CAT-03 要求
「無靜態資料下漏頁或重複」。**offset 分頁在捲動途中有新發布時會位移視窗，讀者會靜默
漏書或看到重複書卡。** 改法：擴充已共用的 `buildCatalogFilter()` 輸出 cursor 契約，
不另開第二條路徑；cursor 帶去另一組條件要明確拒絕。同樣套用 `/api/me/library`。

### 3.2 帳號自助（解除 `open` 註冊的真正封鎖）

目前 auth 只有 login／logout／register。**沒有改密碼、沒有重設、沒有 session 撤銷**——
所以洩漏的 session cookie 除了等 30 天 TTL 到期之外無法失效。工作：改密碼（需重新驗證）、
「登出其他裝置」、以及寄信服務的決策。沒有 email infra 就維持 invite-only、`open` 保持關閉，
並把這個限制寫進 runbook，不要留成隱含狀態。

### 3.3 回收任務

- 過期／已撤銷 session 清理（目前 `app.sessions` 永久累積）
- 失敗匯入的 storage 孤立物件 GC（`storage.ts:76` 註明屬 M7，尚未實作）
- 兩者都要冪等、可與 worker 併行執行、不得刪仍被舊修訂或已發布 release 引用的物件

### 3.4 效能量測（CAT-T5、DB-T4）

在代表性資料量（建議 ~5k 作品、~50k 章節）對多標籤 all／any、關鍵字、複合篩選跑
`EXPLAIN ANALYZE`，把查詢計劃與耗時提交進 repo 作為基線。**先量測再決定索引**，
不憑猜測加索引。

### 3.5 CI 補齊

瀏覽器測試與 `pnpm db:verify` 加入 L2 job。目前 12 個瀏覽器測試只在有人記得時才跑。

**驗收：** ✅ CAT／DB 重跑全過；查詢計劃與耗時已提交（`docs/perf/`）。

**3.4 的結論：** 閱讀器路徑在 4 倍資料下恆為 ~1ms（走索引）；唯一瓶頸是兩端萬用字元
ILIKE。**決定現在不加 pg_trgm**，改寫下觸發條件（>20k 上架作品或關鍵字 p95 >150ms），
理由與計劃見 `docs/perf/README.md`。

---

## Phase 4｜Beta 可運維性 — ✅ 完成 2026-10-03

- **備份還原演練**：DB＋內容物件，**實際還原進一個 scratch database 並驗證可讀**，
  不是在文件裡寫一條 dump 指令
- **結構化請求日誌**：沿用 `http/errors.ts` 已產生的 error `ref` 做關聯
- **基本告警**：`/readyz` 失敗、worker lease 過期／心跳停止
- **Beta runbook**：寫到別人照著做得出來——含部署、migration、建 admin、發邀請碼、
  回復匯入、還原備份、已知限制（無密碼復原、單 process 限流、無圖片資源〔若 Phase 2 未完〕）

**驗收：** ✅ 還原演練**已實際執行並通過 8/8**（含「真的用 API 讀出一章」），
runbook 見 `docs/beta-runbook.md`。§22 M7 出口條件中，除真機 L3 外均已滿足。

---

## Phase 5｜Beta 上線，之後才碰 backlog

只有 Phase 1–4 完成後才動以下項目（全部是 v1.3 明文 backlog，都不阻塞 Beta）：

- taxonomy 合併機制與 alias 表
- 回復補償計劃自動化
- 篩選面板 debounce 即時總數（含把「顯示 N 本」接上已可用的 filtered count endpoint）
- 一個 XHTML 多章錨點拆分、list 內容萃取
- 全文搜尋

---

## 不在計劃內（明確不做）

§02「暫不做」清單維持不變：付款、廣告、社群留言、作者投稿、一般會員上傳、AI 摘要／分章、
朗讀、完整離線下載、PDF／MOBI、DRM 解密、固定版面漫畫與互動影音 EPUB。

分散式限流不在本計劃：§16 已定流量控制屬邊緣／proxy 責任；現行
`http/rate-limit.ts` 是單 process 的濫用上限，**不是 DDoS 防護**，文件與 runbook 都要
照此表述。

---

## 現在的狀態與下一步

Phase 2／3／4 已完成並各自 commit。**Beta 之前剩下的唯一工作是 Phase 1 真機 L3。**

> 原本的建議是「Phase 1 先做、Phase 2 不要並行，因為兩者動到同一條渲染路徑」。
> 實際執行順序與此相反（先完成 2–4）。要如實說明這個取捨的後果：**若 L3 發現回錨
> 或 safe-area 問題，修復時面對的是已經加入圖片 block 渲染的 `ReaderContent`，
> 比原計劃的乾淨狀態複雜。** 風險已承擔，影響面是 `reader/position.ts`、
> `reader/pagination.ts`、`ReaderContent.tsx` 三個檔。

跑 L3 的指令與樣本見 `docs/adr/l3-device-checklist.md`（`pnpm dev:lan` ＋ `pnpm seed:l3`）。
失敗項回報後我處理；全過則 §26 的 M5／M7 可移除「真機待驗」字樣。
