# RV-013｜閱讀時的人名替換與角色互換

- 嚴重度：不適用（功能需求）
- 優先級：P3
- 工作量：中
- 類型：HITL（需決定作用範圍與是否同步到帳號）
- 狀態：open

## 要做的事

讓讀者為一部作品設定人名替換規則（把某個稱謂換成另一個），以及角色互換（兩個名字對調）。替換只影響顯示，canonical 正文不變。

## 分析

### 既有的正確先例

`apps/web/src/reader/conversion.ts` 的繁簡轉換就是同一類功能，而且它的契約正是本票應該沿用的：

- 註釋第 1-3 行：「canonical paragraphs are never mutated — conversion is a pure string map applied per paragraph, so paragraph count and indexes are invariant.」
- `MARKER_RE`（`:20-26`）把 `[[img:…]]`／`[[note:…]]` 這類結構標記排除在轉換之外，註釋說明了理由：對機器語法跑文字轉換「is the kind of thing that breaks silently later」。

人名替換必須遵守同一套規則：純字串映射、逐段套用、段數與 `paragraph_index` 不變、結構標記不碰。這很重要，因為 M5 的定位契約是 `chapter_id + revision_id + paragraph_index`（見 `apps/web/src/reader/member-sync.ts:1-6`），任何改變段數的做法都會令進度、書籤與朗讀位置全部失效。

### 角色互換不能用連續替換

「角色互換」是 A↔B，不是兩條獨立規則。連續套用會塌掉：

```
「A→B」再「B→A」：原文的 A 先變 B，第二條規則又把它變回 A。結果兩個名字都變成 A。
```

必須單次掃描、同時替換 —— 把所有規則的左手邊合成一個 alternation，用一次 `replace` 搭配 callback 查表決定每個命中的輸出。這同時也解決了規則之間互相吃掉彼此結果的問題。

### 必須處理的互動

這類「顯示與 canonical 不同」的功能，風險全在邊界上：

1. **書內搜尋**（`server/src/search/chapter-search.ts`）比對的是 canonical 正文。讀者看到替換後的名字，搜尋它會沒有結果；搜尋原名卻會命中一段他看不到該名字的文字。必須決定：搜尋輸入要不要反向映射，還是明確告知搜尋針對原文。
2. **朗讀**（`apps/web/src/reader/speech-chunks.ts`）應該讀替換後的文字（否則聽到的與看到的不同），所以替換要發生在 chunk 切分之前。
3. **匯出**（`server/src/export/formatters.ts`）在 server 側，完全不知道讀者的替換規則。匯出檔應該是 canonical 原文；需要在 UI 說清楚，否則讀者會以為匯出會帶走他的設定。
4. **錯字回報**（`apps/web/src/reader/ReportTypo.tsx`）會把讀者看到的文字送給管理員。若送出的是替換後文字，管理員會收到一個在原文中不存在的「錯字」。回報必須以 canonical 文字為準。
5. **繁簡轉換的疊加順序。** 規則是用繁體寫的，正文被轉成簡體之後就對不上（反之亦然）。必須定義順序：建議先做人名替換（對 canonical 原文），再做繁簡轉換，並且替換結果本身也會被轉換 —— 這樣一條繁體規則在簡體檢視下也能生效。
6. **重疊規則。** 「張三」與「張三丰」同時有規則時，必須長者優先，否則「張三丰」會被切成「<替換>丰」。單次 alternation 掃描要按長度降序排列左手邊。

### 需要決策的點（HITL）

1. **作用範圍。** 每部作品各自一組規則（合理，人名是書裡的）還是全站一組？建議按作品。
2. **是否同步到帳號。** 訪客用 localStorage 即可；會員是否經 `reader_preferences` 同步到伺服器？現有偏好同步走 `member-sync.ts:151-161` 的 `pushPreferences`，但那是固定欄位的小物件；每部作品一組規則是另一種形狀，需要新的儲存位置與大小上限。
3. **規則上限。** 每本書幾條、每條多長。沒有上限的話，一次 `replace` 的 alternation 會變成病態的 regex。建議每本 20 條、每邊 32 字，並且左手邊不接受空字串。
4. **是否暴露給非會員。** 建議是，與繁簡設定一致（訪客 localStorage-only）。

### 實作形狀建議

- 新模組 `apps/web/src/reader/substitution.ts`，形狀與 `conversion.ts` 對稱：`applySubstitutions(paragraphs, rules): string[]`，純函式、同步、不碰 `MARKER_RE` 段落。
- `ReaderPage.tsx:321-329` 目前是 `original → convertParagraphs → paragraphs`。改成 `original → applySubstitutions → convertParagraphs → paragraphs`，維持單一資料流。
- 規則編輯放在閱讀器設定面板（`ReaderSettings.tsx`），與繁簡設定相鄰。
- 「角色互換」在 UI 上是一個便捷動作：選兩個名字，產生一對互指的規則，而不是另一種機制。

## 驗收條件

- [ ] 替換是逐段的純字串映射：段數與 `paragraph_index` 在任何規則下都不變，並有測試。
- [ ] `[[img:…]]`／`[[note:…]]` 段落不被替換，與 `conversion.ts:20-26` 同一理由並有測試。
- [ ] 角色互換在單次掃描內完成：A↔B 的規則不會塌成單向，並有測試。
- [ ] 重疊規則按左手邊長度降序優先（「張三丰」勝過「張三」），並有測試。
- [ ] 與繁簡轉換的疊加順序已定義、已實作、有測試；一條繁體規則在簡體檢視下仍然生效。
- [ ] 朗讀讀出替換後文字；錯字回報送出 canonical 文字；匯出為 canonical 原文，且 UI 明確說明。
- [ ] 書內搜尋的行為已決定並在 UI 說明，不留下「搜尋看得見的名字卻沒有結果」這種無提示的落差。
- [ ] 規則數量與長度有上限；左手邊為空或僅空白的規則被拒絕；規則集過大時有明確錯誤而非靜默截斷。
- [ ] 訪客以 localStorage 保存；會員是否同步已決策並實作。
- [ ] 長章（10 萬字以上）套用上限數量的規則後，換章與滾動效能無可觀察退化（沿用 `apps/web/scripts/reader-performance.mjs` 的量測方式）。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm --filter web test:browser` 通過。

## 不在範圍

伺服器端替換、管理員層面的全站替換、自動人名偵測或建議、正規表示式規則（只支援字面字串，避免把使用者輸入變成 regex 注入面）、匯出時套用替換。

## 依賴

無。與 RV-012 無關。

## 審查依據

- `apps/web/src/reader/conversion.ts:1-3`、`:20-34`
- `apps/web/src/reader/member-sync.ts:1-6`、`:151-161`
- `apps/web/src/reader/ReaderPage.tsx:320-329`
- `apps/web/src/reader/speech-chunks.ts`、`apps/web/src/reader/ReportTypo.tsx`
- `server/src/search/chapter-search.ts`、`server/src/export/formatters.ts`
