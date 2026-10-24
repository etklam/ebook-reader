# RV-003｜加入 JSON-LD 結構化資料與分享圖

- 嚴重度：中高
- 優先級：P2
- 工作量：中
- 類型：HITL（需決定分享圖來源）
- 狀態：implemented-local（2026-10-24，JSON-LD；og:image 未做）

## 要做的事

全 repo 沒有任何結構化資料，亦從未設定 `og:image`。對一個書目站而言，`Book`／`Article` JSON-LD 是單項收益最大的 SEO 工作；`og:image` 則決定連結被分享出去時長什麼樣。

## 分析

`grep -rn "ld+json|application/ld" apps/web server/src` 沒有任何命中。`apps/web/src/lib/head.ts:83-91` 寫 `og:site_name`、`og:type`、`og:title`、`og:description`、`og:url`、`og:locale`、`twitter:card`，獨缺 `og:image`。`twitter:card` 固定是 `summary`（`:91`），而 `summary` 卡片在沒有圖片時會退化成純文字列 —— 等於現在每一條分享出去的連結都是空白卡。

兩件事都要靠同一塊基礎工作，所以放在同一票：

**JSON-LD。** 需要的欄位全部已在手上：

- 作品頁：`Book`（`name`、`author`、`description`、`url`、`numberOfPages` 或 `hasPart` 計數、`inLanguage: zh-Hant`）。`WorkDetailPage.tsx:72-80` 已經把 `work.title`、`work.author`、`work.description`、`work.chapterCount`、`workPath(work)` 全部拿到手。
- 章節頁：`Article`／`Chapter`，`isPartOf` 指向作品的 `Book`。`ReaderPage.tsx:304-313` 已有 `work`、`chapter.labelRaw`、`chapter.title`、`readPath(...)`。
- catalog：`WebSite` + `SearchAction`（站內搜尋框）。

實作上延伸 `head.ts` 比較自然：`HeadInfo` 多一個 `jsonLd?: object` 欄位，`applyHead` 以同一套 `data-head` upsert／清除機制管理一個 `<script type="application/ld+json">`。這點很重要 —— `head.ts:93-98` 的清除迴圈是整個模組的正確性核心（確保一條 route 不會繼承另一條的欄位），JSON-LD 必須走同一條路徑，否則一本書的 `Book` 標記會殘留在下一本書的頁面上。

**og:image。** 需要人工決策，因為 repo 現在沒有任何圖片來源：

- (a) 一張全站通用的靜態分享圖（最小工作量，卡片上每本書都一樣）；
- (b) 封面圖 —— 但 `works` 表沒有封面欄位，需要 schema + 匯入 + admin UI，是獨立一塊工作；
- (c) 由標題動態生成 OG 圖（需要一條 image route 與字型，API 容器 768Mi 的預算需要量測）。

建議先做 (a) 解除空白卡，並在票內記錄 (b)／(c) 作為後續。

**共同限制（必須在票內寫明，不要假裝解決）。** `head.ts:14-18` 已誠實記錄：這個模組在 JS 載入後才執行。Googlebot 會 render，但不執行 JS 的 crawler（Baidu，以及大部分社交卡片 scraper）只看到 index.html。對一個繁體中文小說站，Baidu 不是可以忽略的流量來源。因此：

- JSON-LD 走 client 側只對 Googlebot 有效；
- `og:image` 走 client 側對社交卡片 scraper **幾乎完全無效**，因為它們通常不執行 JS。

這代表 (a) 若只在 `head.ts` 設定，實際收益接近零。最低可行做法是把全站通用的 `og:image`（以及 `og:site_name`、`og:type: website`）直接寫進 `apps/web/index.html`，讓不執行 JS 的 scraper 至少拿到站級卡片，再由 `head.ts` 針對會 render 的 crawler 覆寫成頁級值。這個「靜態 floor + client 覆寫」的分工也應同時套用到 description（見 RV-005）。

真正的解法是 prerender／SSR，屬獨立一塊工作，本票不應假裝涵蓋。

## 驗收條件

- [ ] 作品頁輸出 `Book` JSON-LD、章節頁輸出 `Article`（`isPartOf` 指向作品）、catalog 輸出 `WebSite`；全部通過 Google Rich Results Test 或等價的 schema 驗證。
- [ ] JSON-LD 由 `applyHead` 以既有 `data-head` 機制管理：切換 route 後不殘留上一頁的標記（需有測試）。
- [ ] JSON-LD 內的文字經過與 XML／HTML 相同等級的轉義處理，作者填寫的標題不能破壞 `<script>` 區塊（`</script>` 與 `<!--` 須處理）。
- [ ] `index.html` 具備站級 `og:image`、`og:site_name`、`og:type`；`head.ts` 在頁級覆寫時不會把它們刪掉。
- [ ] 分享圖方案（a／b／c）已選定並記錄理由；未採用的選項列為後續，不留在驗收條件內。
- [ ] 票內明確記錄「不執行 JS 的 crawler 只看到 index.html」這個剩餘限制，以及它對本票各項收益的影響。

## 不在範圍

prerender／SSR、封面圖的 schema 與匯入流程（若選 (b) 則另開票）、`hreflang`（UI 兩種語言共用同一條 URL，目前不需要）。

## 依賴

無，但與 RV-005 共用 `head.ts` 的同一段 upsert／清除邏輯，建議合併排程以免互相衝突。

## 實作結果（2026-10-24）

只做 JSON-LD；分享圖未做，故本票維持部分完成。

`HeadInfo` 新增 `jsonLd?: Record<string, unknown>`，由 `applyHead` 以同一套 `data-head` upsert／清除機制管理一個 `<script type="application/ld+json">`。序列化時把 `<` 轉成 `\u003c`：`textContent` 本身不會被當 HTML 重新解析，但任何之後把文件序列化回文字的流程都會因為一個 `</script>` 而斷掉。

三種節點：catalog 輸出 `WebSite` + `SearchAction`；作品頁輸出 `Book`（`name`／`author`／`description`／`url`／`numberOfPages`／`inLanguage`）；章節頁輸出 `Article`，`isPartOf` 指向作品的 `Book`，令 500 個兄弟章節不會看起來像 500 篇無關文章。

**非公開作品不輸出任何 graph**：`jsonLd` 由 `indexable = visibility === 'public'` 控制。一個 `Book` 節點本身就是一張收錄邀請函，`unlisted` 不應該有。

**未完成：** `og:image` 與 index.html 的站級 Open Graph floor。需要先決定圖片來源（(a) 全站靜態圖／(b) 封面欄位／(c) 動態生成），而三者都需要一張實際的圖或一塊新工作，不是可以代為決定的事。Google Rich Results Test 亦未跑（需要公開 URL）。

## 審查依據

- `apps/web/src/lib/head.ts:14-18`（已記錄的 JS-only 限制）、`:83-98`
- `apps/web/index.html`
- `apps/web/src/catalog/WorkDetailPage.tsx:72-80`
- `apps/web/src/reader/ReaderPage.tsx:302-317`
