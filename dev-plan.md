**文件日期：2026-09-28｜規格版本：v1.3｜狀態：部分實作（見 §26 進度）｜專案暫稱：Ebook／小說閱讀平台。**

本文件整合本次對話的完整需求，作為新專案的產品規格、工程設計、開發路線及驗收基線。「閱間」只屬命名提案，並未定名。規格內的任務清單（§16A-K、§24 等）保留「未實作」語義的歷史措辭；**實際工程進度以 §26 為準，不要把已完成階段誤讀為 Todo。**

> **核心優先序：可靠匯入及更新 → 章節身分與版本保護 → 手機閱讀體驗 → 書庫、會員與追更。增量不是只追加尾章，覆蓋不是刪除全書重建。**
> 

## 01｜已確認需求與設計預設

### 使用者已確認

手機優先，主要導覽及閱讀控制放在底部；作品分成短篇小說及長篇連載；支援登入與收藏；只有 Admin 匯入 TXT／EPUB；自動分析章節及按閱讀畫面換頁；正文支援繁簡轉換。

新增已確認需求：實作作品分類與標籤，書庫支援同時選擇多個標籤篩選。詳細規格、工程任務與驗收見 03A；分類／標籤與短篇／連載的作品類型分開。

匯入是最重要的功能。同一本作品已有第 1–180 章，再匯入包含第 1–190 章的檔案時，Admin 必須可以選擇增量或覆蓋更新。章節編號容許小數及不規則格式，例如 12.5、12.10、12.5.1、上下篇、番外與無數字標題。

### 本計劃採用的預設，並非額外已確認要求

訪客可閱讀已公開內容；登入後可同步書架、進度及書籤。追更只做站內更新標記，暫不做推送。增量匯入是預設模式；兩種匯入都保留來源缺失的既有章節。匯入結果預設為草稿，發布另行明確確認。繁體顯示預設採香港字形，不預設改寫地域用語。

採用 TypeScript modular monolith 與獨立匯入 worker；資料層基線定為 PostgreSQL 18＋Drizzle ORM＋node-postgres（pg）Pool，migration 使用 Drizzle Kit，人工管理使用 DBeaver＋SSH tunnel，詳細規範見 16A。記憶體、連線上限及所選套件版本仍需在實際部署環境驗證，不將技術選型或任何閱讀 library 視為已完成實作／真機驗收。

## 02｜產品定位、角色與範圍

定位為管理員維護內容的中文小說閱讀網站，不是一般檔案下載站，也不是作者投稿社群。

| 角色 | 主要能力 | 限制 |
| --- | --- | --- |
| 訪客 | 瀏覽、搜尋、閱讀公開作品；本機保存設定及進度 | 不能匯入，沒有跨裝置同步 |
| 會員 | 登入、收藏、書架、書籤、進度同步、連載追更 | 不能發布作品或管理他人資料 |
| Admin | 匯入、比對、覆蓋／增量、章節修正、發布／下架、帳戶管理 | 所有管理 API 都必須驗證權限；不能只靠前端隱藏 |

**MVP 必做：**完整匯入流程、兩種更新模式、不規則章號、插章、修訂歷史、差異預覽、失敗重試、手機閱讀器、繁簡、書庫搜尋、分類／標籤管理、多標籤及複合篩選、登入收藏、書籤進度及基礎追更。

**暫不做：**付款、廣告系統、社群留言、作者投稿、一般會員上傳、AI 摘要／AI 分章、朗讀、全書全文搜尋、完整離線下載、PDF／MOBI、DRM 解密、固定版面漫畫與互動影音 EPUB。先支援明確範圍的文字型可重排 EPUB，不宣稱完整 EPUB 相容性。

## 03｜短篇小說與長篇連載

作品類型使用 short_story／serial；連載狀態另用 ongoing／completed／paused。長篇完結後仍屬 serial，只改連載狀態，不搬到短篇。

短篇通常整篇發布，可有少量章節；結尾顯示「全文完」。連載可整本匯入或持續追加章節，讀到目前最後一章顯示「已讀到最新」；只有作品已完結且讀到最後才顯示「全書完」。類型由 Admin 選擇，不以字數強制分類。

收藏、追更、閱讀進度、已讀章節及手動書籤分開保存。取消收藏不刪進度；取消追更不刪收藏；讀過不自動代表收藏。

書庫搜尋首版支援書名、作者、分類、標籤及繁簡等價查詢。列表顯示簡介、原文繁簡、字數或章節數；連載額外顯示最近發布時間、連載狀態及新章提示。

## 03A｜分類、標籤與多選篩選（MVP 必做）

**新增日期：2026-09-28｜規格版本：v1.1（v1.3 調整見下）｜狀態：Todo，未實作。**

v1.3 調整（2026-09-28 review 後採納）：分類／標籤合併機制與 alias 表延後為 backlog；篩選面板內 debounce 即時總數延後。初版後台詞庫管理只做新增、改名、描述、排序及停用。

使用者已確認需要分類、標籤及多標籤 filter。以下多分類、預設全部符合、分類任一符合、數量限制及後台行為是本計劃的可調整實作預設，不冒充已逐項確認的需求。此模組補齊書庫發現功能，不改變「匯入優先」的核心順序。

### A｜作品類型、分類、標籤分開

| 維度 | 用途 | 例子 | 作品關聯 |
| --- | --- | --- | --- |
| 作品類型 work_type | 內容形式與入口 | 短篇小說、長篇連載 | 一部作品一種類型，不當作 tag |
| 分類 category | 主要題材，提供穩定的瀏覽分類 | 玄幻、都市、科幻、懸疑、言情 | 可多分類；初版採平面分類，不做無限層級樹 |
| 標籤 tag | 跨分類的情節、設定或風格特徵 | 重生、穿越、系統、日常、輕鬆、慢熱 | 可多標籤，同一 tag 可用於不同分類及兩種作品類型 |
| 連載狀態 serial_status | 內容是否持續更新 | 連載中、已完結、暫停 | 獨立狀態，不建立同名狀態標籤充當資料來源 |

例子：「長篇連載／都市＋科幻／重生＋系統＋輕鬆／已完結」。上述例子是初始詞彙提案，不硬編碼為唯一選項；Admin 能自行維護詞庫。

草稿容許尚未分類；首次發布需至少一個有效分類，標籤可為空。既有公開作品日後遷移時，未分類不自動下架，而列入 Admin 待整理清單。每部作品初始上限建議 5 個分類、20 個標籤，均使用可配置限制並在 UI 預先提示。

分類及標籤屬於整部作品，不是逐章標記；第一版不加入用戶私人標籤或章節級分類。

### B｜篩選邏輯：必須明確區分全部／任一

前端文字使用「全部符合」與「任一符合」，內部值為 tag_mode=all／any；預設 all，不能在不同頁面暗中換語義。

| 條件 | 規則 |
| --- | --- |
| 作品類型 | 短篇／連載入口設定相應 type；類型與其他條件取交集 |
| 選多個分類 | 分類內 OR：都市或科幻，有其中一個分類即可 |
| 多標籤，全部符合 | 標籤內 AND：選重生＋系統，作品必須同時有兩者 |
| 多標籤，任一符合 | 標籤內 OR：選重生＋系統，有其中一個即可 |
| 多個連載狀態 | 狀態內 OR；只適用長篇連載，短篇入口不保留隱藏的連載狀態條件 |
| 關鍵字 | 書名／作者／分類名／標籤名的文字匹配可在欄位間 OR；再與選中的 filters 取 AND |
| 不同維度組合 | 類型 AND 分類條件 AND 標籤條件 AND 狀態條件 AND 關鍵字條件 AND 可見性 |
| 未選某個維度 | 不限制該維度；未選標籤時 all／any 都不排除無標籤作品 |

範例：長篇連載 AND（都市 OR 科幻）AND 重生 AND 系統 AND 已完結。切換至任一符合時，只有標籤部分改成（重生 OR 系統），分類及其他條件保持不變。

查無結果必須如實顯示 0 本，保留已選條件並讓使用者移除條件或主動切換模式；不得偷偷由 AND 改 OR、忽略某個 tag 或顯示未符合條件的推薦作品冒充結果。

第一版不做任意巢狀布林 query builder，也不額外加入排除標籤；需要時作後續獨立需求，避免改變上述簡單契約。

### C｜手機篩選體驗與狀態保存

底部可觸及的「篩選」入口打開 bottom sheet，與既有底部四個主導覽相容，不在閱讀器疊加書庫篩選列。面板內容依次為分類、多選標籤、全部／任一符合、連載狀態及排序。

分類與標籤使用可搜尋的 chips／checkbox，多選不因一次點選就自動關閉；標籤多時顯示選中區、搜尋和分頁列表，不渲染整個詞庫。選中狀態有文字／勾選提示，不只靠顏色。

面板區分 draft filters 與 applied filters：按套用才更新正式列表及 URL；取消／關閉還原已套用狀態。底部固定「重設篩選」和「顯示 N 本」；重設在面板內只重設 draft，並保留目前短篇／連載入口與搜尋字串，UI 要說明範圍。總數未取得時顯示「套用篩選」或載入狀態，不編造數字。

符合總數只在按「套用」後取得（v1.3）；面板內的 debounce 即時總數查詢屬 backlog。第一版不為每一個 tag 預測點選後數量，避免複雜 facet count 語義與多餘請求；詞庫搜尋等非同步請求仍須防止較舊結果覆蓋新條件。

套用後列表顯示條件摘要及可移除 chips，例如「都市／科幻、全部符合：重生＋系統、已完結」，可單獨移除 tag，並顯示有效選中數量。零結果時同樣保留 chips。

正式條件保存於 URL，支援刷新、分享、瀏覽器前進／後退及從書籍詳情返回；記錄對應列表的捲動位置。條件或排序改變時重設 cursor 與列表位置，不能沿用上一組篩選的下一頁。

類型切換保留仍適用的分類與標籤；進入短篇時清除連載狀態並顯示正確摘要，不暗藏失效條件。書架內可使用相同 filter 元件，但資料範圍只限目前登入使用者的收藏。

### D｜Admin 分類／標籤管理

後台新增分類及標籤管理頁，提供新增、改名、描述、顯示排序及停用；公開詞庫由 Admin 管理，會員不能自行建立全站 tag。別名表與合併機制延後為 backlog，不在 MVP。

作品編輯頁提供分類多選、標籤搜尋／多選與移除；手機保存按鈕置底。批量操作先顯示受影響作品及「加入／移除／取代」模式：預設加入，不把所有作品原有標籤意外換走。已被他人修改的作品需版本衝突處理，不用舊選擇覆蓋新資料。

名稱與 ID 分離；改名不換 ID，不破壞收藏、URL 或匯入對應。查找候選先以繁簡正規化比對；同義別名指向同一標籤的 alias 機制屬 backlog，初版不能只因自動繁簡轉換或相似字串就合併不同概念。

停用詞彙禁止新指派，保留歷史關聯供管理；需要維持至少一個有效分類的已發布作品須先補分類。前台不繼續提供停用項作新篩選；舊 URL 明確提示失效 filter，不能靜默移除後擴大結果。

合併（來源／目標預覽、交易遷移、舊 ID mapping、循環防護）整體延後為 backlog；初版以停用取代合併，歷史關聯保留。

已被使用的詞彙不提供無提示硬刪除；一律優先停用，保留 audit log。分類／標籤變更不建立新章事件、不改閱讀進度，也不令「最近連載更新」被誤刷新。

### E｜與 TXT／EPUB 匯入的整合及保護

新作品匯入時可選分類與標籤，也可在草稿階段補填。來源內的題材／keywords 僅作候選，不將自由文字自動變成全站詞彙，不用外部 metadata 悄悄建立一堆重複標籤。

更新現有作品時，incremental 與 overwrite **均預設完整保留 Admin 已設定的分類和標籤**。章節模式與作品 taxonomy 是兩個獨立決策；「覆蓋正文」不代表「覆蓋標籤」。來源沒有 taxonomy 更不代表清空。

Admin 要採用來源候選時，另行打開 metadata 變更預覽，明確選擇加入、移除或取代並確認結果。此變更須進入 plan 及版本檢查；預覽後 taxonomy 被另一 Admin 修改，既有 base_edit_version 檢查不得繞過。

重複套用同一已核准 metadata 操作不產生重複關聯。匯入沒有更改 taxonomy 時不得無意義更新關聯時間戳；所有更改都有 actor 與前後集合紀錄。

### F｜資料、查詢與 API 契約

建議新增 categories、tags、work_categories、work_tags。分類／標籤有穩定 id、display_name、description、sort_order、is_active、version。category_aliases／tag_aliases 及合併 mapping 隨合併機制一併延後，不在初版 schema。

work_categories 與 work_tags 使用唯一（work_id, taxonomy_id）關聯，並建立反向（taxonomy_id, work_id）查詢索引。關聯表是資料真相，不用逗號分隔字串或逐頁讀取後再篩選。對名稱做 trim／必要字元驗證及重複候選檢查；搜尋正規化不取代原始名稱或穩定 ID。

書庫與書架 filters 使用同一份型別與後端驗證 schema。前端、API、count 查詢共用一個 filter predicate builder，權限範圍在伺服器設定，不能接受 client 任意指定另一個 user_id。

```
GET /api/works
  type=serial
  category_ids=<id-a>&category_ids=<id-b>
  tag_ids=<id-x>&tag_ids=<id-y>
  tag_mode=all
  statuses=completed
  q=<keyword>
  sort=latest_update
  limit=20
  cursor=<opaque-cursor>

GET /api/works/count              # Same public filters, no pagination
GET /api/categories              # Active public category vocabulary
GET /api/tags?q=<keyword>         # Searchable, paginated active tag vocabulary
GET /api/me/library              # Same filters within the authenticated user's shelf
POST /api/admin/categories
PATCH /api/admin/categories/:id
POST /api/admin/tags
PATCH /api/admin/tags/:id
PATCH /api/admin/works/:workId/taxonomy
```

上例的 id 與 cursor 皆為示意值；不得直接當成實際 UUID 測試資料。taxonomy 寫入提交明確的最終 category_ids／tag_ids 集合、預期版本與操作來源，於交易內驗證並保存；不接受任意原始 SQL 或未授權的來源 ID。

所有清單先去重、驗證有效 ID 再計算模式；初始 filter 上限建議 10 個分類、20 個標籤，limit 預設 20、最多 50，文字 q 亦有限長。無效 enum、未知／停用 ID、超限或與 type 不相容的狀態回傳明確的 invalid_filter，不忽略條件後返回較寬結果。

全部符合的查詢可按每個 tag 使用 EXISTS，或在所選 tag 集合內分組並要求命中不同 tag 數等於所選數；任一符合只需命中其中一個。分類也是存在至少一個命中，維度之間用 AND。不能把未選 tag 也算入命中數，亦不能以重複 join 行湊足 all 條件。

返回單位始終是一部作品；同時命中多分類／標籤不能重複書卡。先套用完整篩選再排序與分頁，total 統計 distinct work_id 並用完全相同的可見性條件，不能先取一頁再在 JavaScript 過濾。

排序只允許定義好的 enum；預設最近上架或最近章節公開更新，最後用 work_id 作穩定次排序。最近更新只根據章節正式發布／作品首次發布，不以分類或標籤編輯時間排序。cursor 綁定正規化 filters＋sort，不能帶去另一組條件。

列表、總數與詞庫 cache key 包括查詢條件、模式、作用域及相關版本；收藏查詢不可使用跨使用者共用的結果快取。發布／下架、taxonomy 指派、改名或停用時失效對應 cache。書庫 counts、書架 counts 及任何 facets 都不得洩露草稿、下架或他人的私人資料。

### G｜工程任務與階段對應

- [ ]  CAT-T1／M1：分類、標籤及關聯 schema、索引、共享 filter 型別、合法資料與邊界 fixtures。
- [ ]  CAT-T2／M2：Admin 詞庫管理、作品多選編輯、匯入 metadata 保護及版本檢查。
- [ ]  CAT-T3／M6：全庫／書架後端複合篩選、all／any、count、去重分頁、URL 正規化及 cache 失效。
- [ ]  CAT-T4／M6：底部篩選面板、搜尋 chips、draft／applied 狀態、零結果、返回恢復及無障礙操作。
- [ ]  CAT-T5／M7：查詢效能量測、權限回歸、併發編輯／匯入、手機真機與所有 CAT 驗收案例。

不新增額外微服務或搜尋引擎作為此模組的前置條件；先以資料庫查詢滿足語義並量測，不能用多標籤功能延後核心匯入驗收。

### H｜新增驗收 CAT-01–CAT-12

| ID | 案例 | 必要結果 |
| --- | --- | --- |
| CAT-01 | A 有重生＋系統；B 只有重生；C 只有系統；D 無標籤 | 選兩標籤：all 只返回 A，any 返回 A／B／C；不選標籤時四者都可符合其他條件 |
| CAT-02 | 多分類＋多標籤＋已完結＋關鍵字 | 分類內 OR，標籤遵從模式，維度間 AND；切模式不改其他條件 |
| CAT-03 | 作品同時命中兩分類及三標籤，結果跨多頁 | 作品不重複、總數正確；先全庫篩選再分頁，無靜態資料下漏頁或重複 |
| CAT-04 | 零結果、空選擇、重複參數、非法 enum、超限 | 不暗中放寬；空選不限制；重複 ID 去重；非法／超限明確報錯 |
| CAT-05 | 手機開面板、連選、取消、套用、重設及鍵盤彈出 | draft／applied 分開；底部操作可見；可多選而不自動關閉；選中提示不只靠顏色 |
| CAT-06 | 刷新、分享 URL、返回／前進、從詳情回列表、切作品類型 | 恢復正確條件及位置；新條件重設 cursor；短篇沒有隱藏連載狀態 |
| CAT-07 | 改名、繁簡正規化查找、停用 | ID 與查找一致；停用／未知條件不靜默忽略，不靜默放寬結果 |
| CAT-08 | 已設分類標籤，1–180 再匯入 1–190＋87.5，兩種模式 | 原 taxonomy 原樣保留；只有另行確認的 metadata 變更可更新 |
| CAT-09 | 匯入來源沒有標籤或含未確認新詞，另有 Admin 同時修改 | 不清空、不自動建詞；過期 plan／taxonomy save 被版本檢查阻止 |
| CAT-10 | 會員寫管理 API、嘗試他人書架、公開 count 含草稿 | 後端拒絕越權；列表與總數均不洩露不可見作品 |
| CAT-11 | 變更指派、發布／下架、慢請求晚返回 | 列表與 count cache 正確失效；舊條件結果不覆蓋新條件；taxonomy 變更不觸發追更 |
| CAT-12 | 批量加入／移除／取代、重試，以及大書庫查詢 | 有預覽、保留非目標關聯、無重複寫入；記錄代表性資料量下查詢計劃、耗時及手機結果 |

以上是本次新增規格與待做工作，不代表 schema、API、UI 或測試已在 repository 實作。

## 04｜手機優先與底部操作

### 一般網站

底部四個主要入口：**短篇｜連載｜書架｜我的**。搜尋及篩選由底部可觸及入口打開，不將重要功能只放在右上角。短篇採緊湊列表，連載突出最近更新；Desktop 適度增加內容寬度，但不反過來支配手機設計。

書籍詳情的主要 CTA「開始／繼續閱讀」與「收藏／追更」放在底部可觸及操作區。返回列表時保留搜尋、篩選與捲動位置。

### 閱讀器

進入閱讀器後隱藏一般網站底部導覽，改為閱讀工具列，避免兩套導覽同時佔位。

底部主要工具列：**返回｜目錄｜書籤｜繁簡｜設定**。分頁模式上方顯示上一頁、當前進度、下一頁；章節切換獨立顯示，不能將上一頁與上一章混成同一個不明確按鈕。捲動模式不顯示翻頁按鈕。

目錄、繁簡、字號、行距、主題等使用 bottom sheet。目錄開啟時定位目前章節，支援搜尋及長列表；設定即時預覽。短屏幕以可捲動面板處理，不讓確認按鈕跑出畫面。

主要點擊區以至少 44×44 CSS px 作為本專案設計目標；支援安全區、鍵盤彈出、橫直屏及動態瀏覽器工具列。正文下方預留空間，不被底部控制遮住。

點擊正文空白可切換沉浸模式；選取文字、操作註腳、連結、縮放時不可誤觸翻頁。滑動只是補充，保留可見按鈕及鍵盤操作；bottom sheet 支援焦點管理、關閉及焦點返回。

閱讀設定：原文／繁體／簡體、捲動／分頁、淺色／米色／深色、字號、字體、行距及正文寬度。初版不做 3D 翻頁動畫，不載入大型遠端中文字體作為開書必要條件。

### Admin 手機介面

匯入結果以卡片和可展開差異為主，不強迫在手機橫向捲動大型表格。底部固定模式、影響章節數及確認按鈕；長正文差異用新舊切換或上下排列，Desktop 才用左右比對。

## 05｜匯入模式：完整行為契約

Admin 先選擇「新作品」或指定現有作品；不因檔名／書名相同而自動覆蓋，也不因重新上傳而自動建立另一本。

| 情況 | 增量匯入 incremental | 覆蓋更新 overwrite |
| --- | --- | --- |
| 已匹配且內容相同 | 跳過 | 跳過，不重寫修訂 |
| 已匹配且正文／章名有修訂 | 保留網站版本，列出被略過修訂 | 建立新章節修訂，保留 chapter_id |
| 確認為新章節 | 新增，可在中間插入 | 新增，可在中間插入 |
| 網站有但本次檔案沒有 | 保留 | 保留，不自動刪章 |
| 疑似同章但匹配不確定 | 先人工確認，不當成新章繞過 | 先人工確認，不自動覆蓋 |
| 新舊已存在章節順序衝突 | 不靜默重排 | 不靜默重排，排序確認獨立於正文覆蓋 |

覆蓋更新預設只處理本次識別、匹配並核准的章名與內容；封面、分類、標籤、簡介、作品類型、作品可見狀態及會員資料不被覆蓋。來源 metadata 可另外預覽後選擇採用。Admin 有自訂章名或未發布修訂時須顯示衝突，不以來源資料默默蓋過。

「完全鏡像來源並刪除缺失章節」不屬 MVP。刪除／下架是獨立操作，必須有影響提示及紀錄。

### 必須通過的基準例子

現有 1–180，新檔案含 1–190；假設舊章中 176 章相同、4 章修訂。增量結果為新增 10、略過 180，其中 4 章保留現有內容；覆蓋結果為新增 10、更新 4、相同跳過 176。兩者都只有 190 個邏輯章節，不產生第二套 1–180。

若新檔案另有 87.5，則總共新增 11 章；87.5 插在 87 與 88 之間，最終 191 章。最大的標籤 190 並不代表只有 190 個章節。

新檔案只含 181–190 時也能追加；只含 1–170 時不能刪掉既有 171–180。同一檔案先增量、後覆蓋必須可行，不能只因檔案 hash 已見過就拒絕。

## 06｜匯入完整流程與任務狀態

流程：指定作品 → 上傳與安全檢查 → 編碼／EPUB 結構解析 → 章節預覽與修正 → 對照目前書庫 → 差異與位置預覽 → 選擇模式及解決衝突 → 確認套用 → 獨立發布確認。

上傳成功、解析成功、套用成功及發布成功是不同狀態。上傳完成後即提供 import_id，使用者可離開後台再返回查看；前端中斷不代表伺服器任務取消。

建議狀態：uploaded、queued、validating、parsing、needs_encoding、needs_review、ready_to_apply、applying、applied、failed、cancelled。明確記錄目前階段、已處理項目、總數若可得、警告、錯誤代碼、重試次數及時間；無法估算時不用虛假的百分比。

解析、diff 及預覽全部在 staging 區，不改正式章節。編碼／分章規則一經修改，產生新的 analysis_version 並令舊預覽失效。未知格式、亂碼、大量匹配歧義或位置衝突不能直接套用。

初版可採「所有阻塞衝突解決後才整批套用」；Admin 可明確排除某些來源項目，但必須顯示排除清單並重算新章順序。取消只在安全檢查點生效，commit 已成功則顯示成功，不能誤報已取消。

## 07｜TXT 編碼與自動分章

### 編碼與文字保護

目標支援 UTF-8、UTF-16、GB18030／GBK、Big5。先辨識 BOM、驗證 UTF-8，再評估候選編碼；抽樣涵蓋首、中、尾段。低信心時讓 Admin 手動選擇並重跑預覽，不把含大量替代字元的結果當成功。

iconv-lite 可處理常見中文與 Unicode 編碼，但解碼能力不等於可靠的編碼偵測，偵測與人工覆核另行設計。官方來源：iconv-lite

永久保留原始上傳檔及 hash。預設只做有限正規化，例如換行統一；段落合併、行尾空白清理及清除廣告文字都必須有獨立選項與預覽，不默默改寫詩歌、對話或留白。

### 分章策略

以可測試規則及一致性分析為主，不依賴 AI。辨識中文數字、阿拉伯數字、小數／多段標籤、英文 Chapter、卷、序章、番外、尾聲、附錄等候選。

判斷需綜合獨立成行、標題長度、前後空行、全文格式一致性、候選密度及相鄰內容。不能只用一條「第 N 章」regex；也不能因為沒有連續整數而判為失敗。

防止目錄頁、引用標題、正文內「第十二章」及重複頁眉被誤當正文起點。顯示疑似空章、異常長／短章、重複標籤與未歸屬內容，但這些是覆核訊號，不一律當成錯誤。

Admin 能指定／移除章節邊界、重命名、設定卷、合併誤拆章，並預覽每章開頭與結尾。解析設定可存為作品的 import profile，須保留版本；自訂規則限制複雜度與執行時間，避免失控 regex。

沒有可靠章節時按段落建立系統閱讀分段，清楚標示非作者原始章節。後續重新分章時重新建立對應關係，不能用分段序號假設與舊內容相同。

## 08｜EPUB 解析與統一內容模型

支援範圍是文字型、可重排版 EPUB 2／3，實際相容性以測試樣本為準。原始檔只作來源與追溯，網站閱讀使用安全清理後的內部內容。

EPUB 的 spine 定義預設閱讀順序；manifest、navigation／舊式 NCX 與封面 metadata 需分別處理。檔案名稱排序不能代替 spine，目錄也不能被當成一個內容檔一章的保證。官方來源：EPUB 3.3

一個 XHTML 可能有多個章節錨點，也可能一個章節跨多個文件；有些目錄項只是重複導覽到同一位置。內部模型要分開邏輯章節、內容 section 及目錄項目，不能重複匯入同一正文。

保留來源 href、fragment、spine 位置與資源對照供比對追溯；這些來源資訊不是永久 chapter_id。圖片、註腳、內部連結及基本格式需重新映射至安全資源；有引用的資源必須一起準備好，不能只更新文字卻漏掉圖片。

缺目錄時可利用文件 heading 產生候選目錄，並要求預覽。損壞檔案顯示具體失敗階段；固定版面、互動內容及 DRM 保護內容明確提示未支援，不無聲丟掉內容後報成功。

**統一策略：TXT 與 EPUB 都先轉為章節式內部模型。** 可產生供 epub.js 使用的衍生 OPF／XHTML manifest，但不把單一整本 EPUB ZIP 當唯一資料真相；追加十章不應要求重建所有章節身分或讓讀者重新下載整本。

## 09｜不規則章號、身分、排序及數量

四個概念必須分離：chapter_id 是固定內部身分；chapter_label_raw 是顯示文字；position 是閱讀順序；chapter_count 是實際筆數。

允許的例子包括：第 12 章、第 12.5 章、第 12.10 章、第 12.5.1 章、第 12 章（上）、第 12 章（下）、第 012 章、番外 1.5、序章、終章及無數字標題。無法辨識編號可保留 null 的解析資訊，但不能拒收整章。

標籤使用 TEXT，不使用 FLOAT／DECIMAL 作為主身分。12.10 與 12.1、12.5 與 12.50 均保留原字串，不因數值相等而合併；作者可能使用小數或子章編號，系統不替作者猜。

為比對建立的 parsed_label 可保存文字 token 序列及 suffix，不能消除有意義的小數尾零、上下篇或卷資訊。正規化只用於候選生成，不改原始顯示，也不設置唯一章號約束。

初版的內部 position 可使用整數，插章時於受鎖定交易內調整受影響區段，並處理唯一順序約束；它不是作者的編號。前台與 API 全部按 position，而非按 parseFloat(label) 或字典序閱讀。

公開章節數只統計實際已發布且可讀的邏輯章節；Admin 分別顯示已發布／草稿／隱藏數量。目錄重複連結、spine 檔案數及最大章號都不等於章節數。

## 10｜章節匹配與差異分類

### 先確定「同一章」，再判斷「有沒有修改」

在指定 work_id 內比對，綜合所屬卷、原始／解析標籤、章名、內容指紋、相鄰已匹配章節及歷次人工確認。來源路徑、章號或 hash 都不能獨立決定身分。

保守匹配流程：先檢查已確認來源對應是否仍與目前結構一致；再找卷內唯一、標籤／標題及鄰接證據一致的匹配；正文相似或改名只產生候選。重複段落、極短空章、章號重置及跨格式匯入提高覆核要求。

每個來源候選最多對應一個現有章節，同一個現有章節不能被兩個來源候選自動覆蓋。所有自動匹配保存 reason_codes、使用的證據及規則版本；所謂 confidence 是工程規則輸出，不宣稱為校準過的正確機率。

僅有相同內容但位於不同卷或不同位置，不能自動刪去其中一份。合章／拆章／大量重編號標記 structural_conflict，初版由 Admin 映射或先修正來源，不自動猜測內容遷移。

### 三種 hash 的角色

file_hash：原始檔去重與解析快取；不能代表本次套用已完成。

body_compare_hash：繁簡轉換前、有限正規化後的正文比較，保留標點及段落語義。

revision_hash：含章名、清理後結構、資源引用與內容的修訂比較；正文沒變但圖片／連結有變也要被識別。清理與正規化版本變更須重新評估，不將升級後不同 hash 一律當作者修訂。

### 差異狀態與預覽

分類為 unchanged、modified、new、missing_from_source、ambiguous、structural_conflict。預覽顯示來源／目標章名、所屬卷、預計插入位置、修改摘要、匹配理由及發布影響；列表與 diff 分頁載入。

相同章節不顯示整段正文以減少雜訊；modified 提供安全的段落級差異。Admin 可確定匹配現有章、指定為新章、排除來源項目、修正邊界與位置，所有操作都令 plan_version 更新。

## 11｜中間插章及不完整檔案的合併順序

完整新版出現 87 → 87.5 → 88，且 87、88 均已可靠匹配，則把 87.5 放入兩個錨點之間。原有 chapter_id 不變，其他用戶讀到 180 的位置亦不因 position 改變而移動到別章。

只上傳局部新章時，根據可靠相鄰錨點判斷位置；沒有足夠錨點就要求 Admin 指定卷及「放在某章之前／之後」。不能只用小數大小推斷插入位置，亦不把所有無編號章自動放最後。

來源缺失的既有章節保持原有相對順序。若來源提供的新順序與現有順序矛盾，或兩個錨點之間包含未出現在來源的舊章，預覽必須展示合併後序列並要求確認，不自動選一個可能錯的排列。

不允許因為 UI 選了 overwrite，就順便將全書按章號重排。若 Admin 明確批准重排，排序變動獨立記錄，可追溯、可驗收。

## 12｜穩定修訂、交易、冪等與復原

### 章節與修訂分離

chapters 保存固定 chapter_id；chapter_revisions 保存不可變正文修訂。更新只建立修訂及改變引用，不刪舊章再建立新 ID。未變章節不重建、不更新無意義的時間戳。

原始上傳、解析產物、比對決策、更新前後 revision_id、排序變動及 Admin 身分都需追溯。人工修改過的未發布章節不能在沒有衝突提示下被蓋過。

### Staging 與一致套用

先在 staging 準備內容、衍生繁簡及引用資源，全部驗證後才進入短 DB transaction。交易內檢查 Admin 權限、鎖定作品或採等效串行化、驗證 edit_version、寫修訂引用／新章／排序／匯入結果並提交。

PostgreSQL 提供 row-level 與 advisory lock 等鎖機制；具體實作優先選擇可測試的作品行鎖與樂觀版本檢查，而不是只相信前端禁用按鈕。官方來源：PostgreSQL Explicit Locking

解析、解壓、diff 與大檔寫入不得放在長交易內。物件儲存與 DB 不是同一個交易：先完成不可變檔案準備，再提交引用；失敗留下的孤立 staging 由延後清理處理，不能刪掉仍被舊修訂或已發布內容引用的資源。

### 過期預覽與冪等

每份 apply plan 綁定 work_id、base_edit_version、analysis_version、plan_version、mode 及已核准操作摘要。預覽後若作品被另一 Admin 改動，拒絕套用舊 plan，重新比對。

套用需要 Idempotency-Key；相同 key 與相同操作返回同一結果，不重複建章；相同 key 搭配不同 payload 拒絕。冪等記錄與內容變更同交易提交；worker 重送與 API response 丟失都不能產生雙份結果。

同檔先增量後覆蓋是不同 plan，允許新的 key 並對照最新內容。只依賴檔案 hash 去重或 queue 的「只執行一次」承諾均不足。

### 復原與中途失敗

本次套用失敗時正式內容不應半新半舊。已提交後 worker 崩潰，重試從持久化結果恢復，不重複套用。

第一版提供匯入歷史與受保護的回復操作：只有作品仍在該次變更版本且沒有後續衝突時可直接回復；否則明確提示版本已變，由 Admin 手動處理，補償計劃自動化屬 backlog（v1.3 延後），且不撤銷其他 Admin 後來的修改。回復不刪會員書籤；被移出的章節保留墓碑／歷史引用及可理解提示。

## 13｜發布、版本一致性與追更

書籍可見性、章節草稿及正式發布分開。匯入套用預設建立或更新編輯版本，讀者仍讀目前公開版本；確認頁可讓 Admin 明確選擇稍後發布或發布已審核變更，不能在背景自動上架。

建議以輕量 work_release 保存一次公開目錄及 chapter_id → revision_id 的快照；正文仍按章節資源讀取，不打包整本 ZIP。新發布完成後一次切換 active_release_id，避免目錄已更新但對應正文尚未可讀。

開啟中的閱讀器可固定目前 release，收到新版本提示後安全切換；已下架或撤權內容仍須在讀取 API 重新檢查，不能因舊 release URL 就繞過權限。正在修改的章節不在讀者眼前突然跳段。

追更以新 chapter_id 的首次公開發布為依據；修正錯字、改封面、改標題或重新發布同一章不當新增。發布事件採具唯一鍵的 durable outbox 或等效機制，重試不能重複建立更新通知。

中間新插的 87.5 即使用戶已讀到 180，也列為未讀新章。「繼續閱讀」仍回上次位置，另提供「查看新章」，不自動跳走。

未讀章節以已發布集合與 user_chapter_reads 比對，不能用最大章號減已讀章號。開始追更時，既有未讀可稱「未讀章節」，加入追更後首次發布的才稱「新增更新」，避免混淆。

## 14｜分頁、定位、進度與書籤

匯入時分析的是邏輯章節及段落；瀏覽器按畫面尺寸、字號及行距動態分頁，不以固定 1,000 字作一頁。EPUB 的 reflowable 與 pre-paginated 是不同版面模型，本專案聚焦前者。官方來源：EPUB Reading Systems 3.3

持久化定位收斂為 work_id＋chapter_id＋revision_id＋paragraph_index（v1.3），另存文字顯示模式及必要版本資訊。畫面頁碼及整本 CFI 只能作特定版本／渲染情境的補充，不能成為唯一的跨版本主鍵；文字 fingerprint／字元級跨修訂映射屬 backlog，不阻塞 MVP。

插章會改變全書順序；繁簡轉換也可能改變字元位置。回復先找穩定章節，再找段落；跨修訂只做近似回復（同章同 paragraph_index 或章首）並明確提示版本已更新，不假裝精確。手動書籤永久保留建立當時的原始定位數據（chapter_id、revision_id、paragraph_index），版本更新後只用於近似回復，不改寫歷史數據，供日後升級映射時使用。

初版驗收：改字號、橫直屏、繁簡切換及換裝置後，至少回到同一邏輯段落；段落已被刪除時有明確 fallback。讀取進度以最近閱讀位置為準，不以讀得最遠取代最近位置。

本機先保存，再節流同步；離頁事件僅作補充，不能作唯一保存機制。API 使用 server revision／If-Match 等衝突控制，舊裝置的延遲寫入不能靜默覆蓋新進度。沒有網絡時繼續閱讀目前已載入內容，顯示待同步；不因此承諾完整離線全書。

已讀章節與目前游標分開。只有讀到章末或明確標記才視為完成；跳到 180 不推論 1–179 全部讀完。新增章節可令「已讀到最新」變成「有更新」，但不刪歷史完成紀錄。

## 15｜繁簡轉換與快取

顯示模式：原文、繁體、簡體。原文永久保留；每次由原文產生目標版本，不用簡轉繁再轉簡作為還原。網站介面語言與正文顯示模式分開。

建議使用 OpenCC／opencc-js；opencc-js 是瀏覽器與 Node.js 可用的純 JavaScript 實作，但與官方引擎不保證每個輸入完全一致，必須鎖定選用版本及字典並驗收。官方來源：opencc-js

由 Admin 設定或確認來源繁簡／字形，混合內容保留提示；輸出香港繁體作初始偏好，台灣字形可列後續選項。轉換不能保證人名、古文及歧義字詞全正確，「原文」必須隨時可切換。

worker 只為新增／被更新章節產生繁簡衍生內容，或按明確策略懶生成；不能每次匯入重新轉整本。快取鍵包含 chapter_revision_id、target_locale、converter_version、dictionary_version 及 renderer／sanitizer 版本。

只轉換正文及必要的可讀標籤，不改 DOM ID、href、資源路徑、CSS、class 或程式碼。不同文字版本共享同一套邏輯段落錨點。跨 HTML 文字節點的詞組需測試，不能因逐節點處理而任意破壞格式或詞義。

書名、作者及查詢字串另建繁簡搜尋用正規化值，保留原始顯示。轉換結果不作章節身分或作者修訂比較的唯一依據。

## 16｜技術架構與選型

建議獨立專案，與 diary-v3 不共用業務資料或會員權限；可沿用熟悉的工程慣例，但本次不承諾跨專案整合。

| 層 | 建議 | 責任／限制 |
| --- | --- | --- |
| Web | React＋TypeScript＋Vite | 手機 UI、閱讀殼層、按路由分包；版本於起專案時鎖定 |
| API | Node.js＋Hono | modular monolith；auth、catalog、library、imports、publishing 模組分界 |
| 資料 | PostgreSQL 18＋Drizzle ORM＋node-postgres（pg.Pool） | metadata、章節修訂引用、工作狀態及會員資料；Drizzle Kit 管理 SQL migration，連線與部署規範見 16A |
| 匯入 worker | 同 repo 獨立 process，PostgreSQL-backed queue | 初版單 worker／低併發；具 retry、lease／heartbeat 與取消 |
| 內容儲存 | private volume 起步，Storage adapter | 原檔、章節內容、圖片及衍生檔；之後可接 S3-compatible storage |
| 閱讀引擎候選 | epub.js 與 foliate-js 雙候選 POC，外包自己的 ReaderAdapter | 只處理渲染與定位，不管理章節身分、匯入或會員；同環境同真機比較後只整合一個 |
| 繁簡／編碼 | OpenCC 或 opencc-js；iconv-lite | 規則及版本可追溯，不能把轉換當來源正規化 |
| 部署 | Docker Compose 起步 | Web／API、worker、PostgreSQL、reverse proxy；既有 k3s 可後續適配 |

epub.js 與 foliate-js 均提供分頁、捲動、定位等能力，作為 M0 的雙候選 POC：同環境、同測試樣本、同真機比較，選定後只整合一個。foliate-js 同樣基於 iframe＋CSS multi-column，且 API 尚未穩定，不是免驗證的替代品；epub.js 需記錄 npm 發布版本與 upstream commit 的差異。這些功能不等於已滿足本專案的增量／版本與手機要求。官方來源：epub.js、foliate-js

**M0 必須驗證的閱讀 gate：**按章資源載入、穩定定位、繁簡後重排、底部控制與 iframe 事件、安全清理相容性，以及 iOS／Android 實機。兩個候選均未通過 gate 時，在不改章節模型的前提下另尋 adapter；不為遷就 library 而犧牲匯入契約。

初版不引入 Kafka、Elasticsearch、微服務或必需 Redis；日後有實際瓶頸才加入。Redis 不是 DDoS 的完整解法，流量控制從邊緣、proxy、API 限額及 worker 資源隔離設計。

## 16A｜資料庫、連線與部署規範（v1.2）

**更新日期：2026-09-28｜狀態：Planning／Todo。**

本節將本次資料庫討論納入既有計劃，作為 M1、M4、M7 的工程基線；沒有建立真實資料庫、執行 migration、配置伺服器或驗證連線。容量與 timeout 是可調整的起始值，不是已壓測結果。

### A｜選型與連線路徑

**Database：PostgreSQL 18；ORM／query builder：Drizzle ORM；driver／pool：node-postgres 的 pg.Pool；migration：Drizzle Kit；人工管理：DBeaver＋SSH tunnel。**

```
React / mobile browser
  → Hono API
  → Drizzle ORM
  → pg.Pool
  → PostgreSQL 18

Import worker
  → Its own bounded pg.Pool
  → The same project database

DBeaver
  → SSH tunnel
  → PostgreSQL, using a separate maintenance account
```

Drizzle 官方支援將既有 pg.Pool 傳入；ORM 負責查詢組合，不代替 driver、連線池或資料庫權限。官方來源：Drizzle PostgreSQL

PostgreSQL 18 是本計劃選定的 major baseline，不宣稱永遠是最新版本。起專案時鎖定經驗證的 minor version／Docker image digest 及套件 lockfile；不使用浮動 latest，不因文件展示 prerelease 範例就自動採用 rc／beta。重大升級需獨立 migration／還原演練。

前端不能直連 DB；DATABASE_URL、帳密及 CA 設定只在後端 secret／環境設定中，不得放入 VITE_*、前端 bundle、repository 或公開 Notion 範例。

### B｜Database／schema／環境配置

每個環境使用獨立 database：正式名稱建議 ebook，開發 ebook_dev，測試 ebook_test；正式與開發／測試 credentials 分離，不能讓測試清理連到正式資料。正式 database 與 diary-v3 分開，不共用作品或會員 tables。

同一環境所有作品共用 tables，以 work_id 區分；不按每本書建立 database 或 table。

建議 schema：app 放業務資料，drizzle 放 migration metadata；jobs 是 queue namespace 的預留名稱，實際使用所選 library 支援的 schema。Drizzle migration 只管理應用程式擁有的物件，不掃描或刪除 queue library 自管 tables。

SQL／Drizzle schema 使用明確 schema-qualified names；runtime 不取得 schema CREATE 權限，search_path 不包含可被低權限帳戶建立物件的 namespace。schema 名稱本身不等於安全隔離。

資料庫 encoding 設 UTF8，連線／維運時區統一 UTC，時間點欄位使用 timestamptz；顯示時再轉用戶時區。TXT 的 Big5／GB18030 等編碼先正確解碼，不能把原始亂碼直接寫入 UTF8 database。

### C｜欄位、約束與索引的具體基線

沿用第 17 節既有命名：chapters.id、work_id、volume_id、label_raw、editorial_position、head_revision_id。前文 chapter_label／chapter_label_raw／position 屬概念或示例名稱，實作不另建一套重複欄位；公開版本的順序由 release_items.position 保存。

| 欄位／資料 | 建議型別及規則 |
| --- | --- |
| chapter id、work id、revision id | UUID，身分穩定；更新正文不重新建立 chapter id |
| label_raw | TEXT；12.10、12.1、12.5.1、上下篇及番外原樣保留，不設數值型別或全書章號唯一約束 |
| editorial_position／release_items.position | INTEGER；與作者標籤分開，插章按錨點調整順序 |
| 章節修訂 | 不可變 revision，保存 title、content_key、body_compare_hash、revision_hash、處理版本及來源 import id |
| created_at／published_at／read_at | TIMESTAMPTZ；各時間有獨立語義，改標籤不冒充發布新章 |
| 解析警告／匹配理由／彈性設定 | 可使用 JSONB；不能以 JSONB 或逗號字串取代核心分類標籤關聯及章節身分 |

重要約束：work_tags 的（work_id, tag_id）唯一；work_categories 的（work_id, category_id）唯一；user_library／reading_progress 各自的（user_id, work_id）唯一；user_chapter_reads 的（user_id, chapter_id）唯一；release_items 的（release_id, chapter_id）及（release_id, position）各自唯一。手動書籤容許同一本作品有多筆，不誤套書架唯一約束。

用 FK 保護作品、卷、章節、修訂及閱讀引用；必要處用複合 FK／相應唯一鍵確保 revision 屬於所引用 chapter、chapter 與 volume／release 同屬該作品，不能只驗證各個 UUID 各自存在。不可用查詢別表的 CHECK 假裝完成跨表完整性。

編輯順序若設唯一約束，要採延後檢查或經驗證的安全重排流程，避免中間插章時逐行更新撞位；所有變動在作品鎖與短交易內完成。被閱讀進度／舊 release 引用的章節或修訂預設不得任意 cascade 刪除。

常用索引：chapters（work_id, editorial_position）、chapter_revisions（chapter_id, created_at）、work_tags（tag_id, work_id）、work_categories（category_id, work_id）、release_items（release_id, position）、import_jobs（status, created_at），以及個人書架／進度的 user scope 索引。PK／UNIQUE 已建立的索引不重複加；FK 引用端仍按實際查詢補索引。官方來源：PostgreSQL Constraints

多標籤 all／any 查詢沿用 03A，關聯表是唯一正式來源，先全庫篩選再分頁。中文搜尋先以繁簡正規化欄位及參數化查詢實作；額外文字索引須經中文長／短 query 量測，不把 PostgreSQL 預設搜尋視為已解決中文斷詞。

### D｜正文與檔案儲存分工

PostgreSQL 保存 metadata、章節與版本引用、順序、hash、分類標籤、會員資料、匯入計劃及 audit。Private storage 保存原始 TXT／EPUB、逐章清理後 XHTML／內容檔、圖片，以及繁簡衍生檔；衍生內容是否可重建須在 metadata 標明。

初版 storage 可用 VPS private volume，保留 Storage adapter，之後才接物件儲存；不需要為 MVP 額外購買雲端 database 或 object storage。

重點不是「DB 不能存正文」，而是沿用本專案逐章內容與 EPUB 資源架構。content_key 只在後端解析，不能接受使用者任意指定檔案路徑。

檔案寫入不與 PostgreSQL 共用 transaction：先完成不可變內容與依賴資源，驗證成功後才提交 DB 引用。DB commit 失敗可留下待清理 staging，但不能留下指向未完成資源的正式修訂。清理需檢查舊 revision、release 及備份保留範圍。

### E｜Docker 與初始資源設定

正式 DB 初版採官方 PostgreSQL 18 Docker image＋本機 SSD／NVMe 持久化 volume，單 instance；NFS 先用於備份或內容資源，不作本計劃初版 PGDATA。這是部署風險取捨，不宣稱所有 NFS 都不可用。

PostgreSQL 18 官方 image 的 volume 掛載目標使用 /var/lib/postgresql，預設 PGDATA 為 /var/lib/postgresql/18/docker；不能照搬舊版 /var/lib/postgresql/data 的假設。Docker 初始化環境變數／init scripts 只在空資料目錄生效，不能靠改 POSTGRES_PASSWORD 環境變數完成既有 DB 密碼輪替。官方來源：PostgreSQL Docker image

以下起始設定假設為 DB 預留約 2 GiB 記憶體預算，API／worker 另計；不把使用者整台伺服器記憶體當作 DB 專用容量。

| 設定 | 初始值 | 注意事項 |
| --- | --- | --- |
| max_connections | 50 | 包含所有 runtime、queue、migration、維運與其他連線；保留管理餘額 |
| shared_buffers | 512MB | 依 DB 實際記憶體／容器限制再調整 |
| work_mem | 4MB | 不是全 instance 的總額，勿直接大幅提高 |
| maintenance_work_mem | 64MB | 維護作業併發與其他服務共存需量測 |
| DB／session timezone | UTC | UI 顯示另做時區轉換 |

work_mem 可被同一 query 的多個排序／hash 操作及並行 sessions 同時使用；以上參數不是公式化的容量保證。保持 autovacuum、fsync 等正常安全設定，不以關閉資料持久性換 benchmark。容器 shared memory 與整體 memory limit 需另驗證。官方來源：PostgreSQL Resource Consumption

DB port 不暴露到公網。API／worker 由受控內網連線；需要主機 SSH tunnel 時只綁 loopback 或受控 private interface，並配置 firewall／pg_hba 規則。Production 不部署公開可訪問的 SQL 管理網頁作捷徑。

### F｜帳戶、權限與 secrets

| 角色 | 用途 | 權限界線 |
| --- | --- | --- |
| Bootstrap superuser | 首次建立 database、roles 及必要管理工作 | 獨立保管，不注入 API／worker |
| ebook_migrator | 部署 SQL migration，建立／修改 app 與 migration 物件 | 僅部署時使用；一般 runtime 不可繼承／切換為此角色 |
| ebook_api | API 必要 SELECT／INSERT／UPDATE／DELETE | 無 DDL、無 superuser；只授予業務所需 tables／views／functions |
| ebook_worker | 匯入、修訂及 queue 所需讀寫 | 不因 queue 初始化需求而授予整個 database DDL；初始化移至受控部署流程 |
| 人工維運帳戶 | DBeaver 查資料與故障診斷 | 日常以 read-only 為主；高權限另行授權及稽核 |

官方 image 的 POSTGRES_USER 會建立 superuser，不能直接視為低權限的 ebook_api。官方來源：Docker POSTGRES_USER

初始 grants 與 ALTER DEFAULT PRIVILEGES 針對實際建立物件的 migration role 設定，並於每輪 migration 驗證新 tables／sequences 的必要授權；不是設定一次就對所有 creator role 自動生效。未授權 schema 不對 PUBLIC 開放 CREATE。官方來源：PostgreSQL Default Privileges

Credentials 用部署 secrets 注入；API、worker、migration 各自使用對應連線設定。Log 不輸出完整 DATABASE_URL、密碼、token 或私人正文；範例只保存佔位值。密碼輪替需改 DB role、更新 secret、排空／重建 pool 並驗證，不假設環境變數會修改既有帳戶。

### G｜Connection pool、timeout、TLS 及 transaction

每個 API process 只建立一個可重用的業務 pool；worker 另外建立自己的有限 pool，不在每個 request／job new Pool。手動取得 client 必須在 finally 歸還；停止服務先停止接收新請求與新任務，完成或有界取消現有工作，再 pool.end。官方來源：node-postgres Pooling

初始上限：每個 API process max=5；每個 worker 的業務 pool max=2；migration max=1。Queue library 自己的 pool、LISTEN 連線及管理工具另計，不能以 worker 業務 pool=2 宣稱整個 worker 只用兩條連線。

連線預算為「API replicas×每份 pool＋worker replicas×業務 pool＋queue／專用連線＋migration＋維運」，總和需低於 DB 可用上限並保留故障維運餘額。Rolling deployment 的暫時副本同樣計入，新增 replicas 前重新驗證。官方來源：Pool Sizing

API 起始 timeout：connectionTimeoutMillis=5000、idleTimeoutMillis=30000、statement_timeout=5000、idle_in_transaction_session_timeout=15000；lock_timeout 可另設較短起始值。Worker／migration 使用獨立設定，不為匯入而提高全站 API query timeout。連線等待上限與 HTTP request deadline、worker task timeout 分別管理。官方來源：pg.Client configuration

TLS 預設驗證 CA 與 hostname；跨主機／託管資料庫使用正確憑證設定。只有明確記錄的本機開發或同機隔離部署才准許 DB_TLS=disable。不能用 rejectUnauthorized=false 解決憑證失敗；DATABASE_URL 的 sslmode／sslcert 等設定不可與程式內 ssl 物件互相覆蓋。官方來源：node-postgres SSL

匯入解析、diff、繁簡及資源準備都在 transaction 外。套用用 db.transaction(async tx => ...)；transaction 內全部 query 使用 tx，不混用另一個 pool.query／全域 db。作品鎖、base_edit_version 檢查、revision 引用、順序、idempotency 結果及發布引用按既有契約一致提交。失敗需要 rollback，不在已中止的 transaction 上繼續寫入。官方來源：node-postgres Transactions

DB 斷線或 pool 飽和須有可辨識錯誤、readiness／指標及有界退避；不無限重試全部寫入，尤其不把「commit 回應遺失」直接當未提交。依持久化 idempotency 記錄判斷結果。

### H｜API 連線模組參考

以下是待加入 repository 並 typecheck／整合測試的 API 參考，不是已部署代碼。由應用程式 bootstrap 先載入環境設定，再 import 此模組；worker 沿用相同驗證原則但使用自己的 pool／timeout 設定。選定的 drizzle-orm、drizzle-kit、pg、@types/pg 版本需鎖定。

```tsx
// src/db/client.ts
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

function parseDatabaseUrl(value: string): URL {
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error('Unsupported protocol');
    }
    return parsed;
  } catch {
    // Do not include the connection string in errors.
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
}

const url = parseDatabaseUrl(connectionString);
const tlsParameters = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'];
if (tlsParameters.some((key) => url.searchParams.has(key))) {
  throw new Error('Configure TLS with DB_TLS and DB_CA_FILE instead');
}

const tlsMode = process.env.DB_TLS ?? 'verify-full';
if (!['verify-full', 'disable'].includes(tlsMode)) {
  throw new Error('DB_TLS must be verify-full or disable');
}

export const pool = new Pool({
  connectionString,
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 5_000,
  idle_in_transaction_session_timeout: 15_000,
  application_name: 'ebook-api',
  ssl: tlsMode === 'disable'
    ? false
    : {
        rejectUnauthorized: true,
        ...(process.env.DB_CA_FILE
          ? { ca: readFileSync(process.env.DB_CA_FILE, 'utf8') }
          : {}),
      },
});

pool.on('error', () => {
  // Replace with the application's redacted logger and metrics.
  console.error('Unexpected database pool error');
});

export const db = drizzle({ client: pool });

export async function checkDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
```

連線模組之外還必須實作：啟動 readiness、路由 query error handling、shutdown deadline、pool total／idle／waiting 指標、credentials redaction，以及實際 schema 查詢；SELECT 1 成功不代表 migration 與 grants 已正確。

### I｜Migration、部署與人工連線

採 code-first、可審查 SQL migration 流程：修改 Drizzle schema → drizzle-kit generate → 檢查 SQL／索引／FK／資料保留 → 提交 Git → CI 在空 DB 及已有資料的 fixture DB 測試 → 部署單一 migration job 執行 drizzle-kit migrate → 驗證 grants → API／worker readiness。

不在 production 使用臨時 push 作常規 schema 更新，也不讓每個 API replica 啟動時同時跑 migration。這是本專案的可追溯性規則，不宣稱 Drizzle 其他流程全部不可用。官方來源：Drizzle Migrations

禁止對不屬於 app 的 queue／extension schema 生成破壞性 diff。已有資料的欄位改名需檢查不是 drop＋create；重大變更使用可相容的分步流程並先備份。資料回填分批執行，與短鎖 schema 變更分開；可能不能在一般 transaction 中執行的索引維護須採專用受控流程。不得宣稱所有 migration 都能自動無損 rollback。

本機管理使用 DBeaver PostgreSQL driver＋SSH tunnel，連線採人工維運帳戶；唔為方便而公開 5432。章節修訂／排序等日常內容變更仍經 Admin 後台，緊急 SQL 修補需稽核並檢查版本／cache。官方來源：DBeaver SSH

### J｜備份、還原與維運

初版建議每日 pg_dump custom-format 備份及異機加密保存，並備份相關 private storage、必要部署設定與受控的 role/grant 重建程序；不得將「每天」視為使用者已接受的資料損失目標，Beta 前要記錄實際 RPO／RTO 需求。

pg_dump 可產生單 database 一致快照，但不包含 cluster-wide roles 等全域物件，也不包含外部章節檔案。官方來源：PostgreSQL pg_dump

應保存本次 dump 引用的不可變內容集合及 hashes，備份／還原期間避免資源清理刪掉所需檔案；只拷貝一個 DB dump 不能宣稱整站已可還原。完整還原演練包含作品、舊 revision、active release、書籤／進度與 content_key 可讀性檢查。

備份失敗、磁碟不足、連線等待、長 transaction、鎖等待及 worker 積壓需可觀察。保留 autovacuum，評估長期匯入修訂／閱讀進度更新造成的資料膨脹；唔因首次測試快就省略維運。若需要比每日備份更小的資料損失窗口，另設 WAL 歸檔／PITR 工作，不在本次更新假裝已配置。

### K｜工程任務與資料庫驗收

- [ ]  DB-T1／M1：鎖定版本、Docker volume、環境隔離、UTF8／UTC、roles／grants、secrets 與 schema namespace。
- [ ]  DB-T2／M1：Drizzle schema、可審查 SQL migration、核心 FK／UNIQUE／索引、API／worker pool、readiness 及 shutdown。
- [ ]  DB-T3／M4：同 client transaction、作品鎖、版本檢查、冪等重試、插章與 revision／release 完整性及故障注入。
- [ ]  DB-T4／M7：連線與記憶體量測、TLS／權限回歸、升級演練、DB＋內容資源備份還原及維運手冊。

| ID | 驗收案例 | 必要結果 |
| --- | --- | --- |
| DB-01 | 空 DB migration，以及有資料的舊 schema 升級 | 可重現啟動；資料保留；不觸碰 queue 自管 schema；只有單一部署 migration runner |
| DB-02 | API／worker／維運帳戶及 migration 新 table | runtime 無 superuser／DDL；必要權限正確；不能切換為 migrator；secret 不進前端／log |
| DB-03 | 12.10／12.1／12.5.1、不同卷同號、錯誤 revision 引用、重複 tag／收藏 | 奇怪章號原樣保存；合法同號可共存；錯配與重複關聯由 DB 約束阻止 |
| DB-04 | 1–180 更新至 1–190＋87.5，故障注入及回應遺失 | 增量／覆蓋符合契約；章節 ID 不變；無半提交、重複章或已發布缺檔引用 |
| DB-05 | pool 飽和、query timeout、斷線、重啟、rolling replicas | 總連線不超預算；有界失敗／恢復；client 歸還，無洩漏／無限等待；停止流程可結束 |
| DB-06 | TLS hostname／CA 不符、錯誤密碼、未授權網路 | 安全拒絕、不回退為不驗證；5432 不對公網開放；錯誤訊息不洩露 credentials |
| DB-07 | 清空測試環境後從 DB＋內容備份還原 | 作品、release、修訂、會員進度及圖片可用；可按文件重建權限；記錄耗時與缺漏 |
| DB-08 | 代表性資料集下多標籤 all／any、目錄、書架及匯入併發 | 結果正確；記錄 query plan、P95、pool waiting 與記憶體；根據量測調參，不虛報容量 |

全部 DB-T／DB 驗收目前為 Todo；本節補充而不取代既有 IMP、CAT、READ、PUB、SEC、OPS 驗收。

## 17｜核心資料模型及約束

以下為概念 schema，不是已執行的 migration。v1.2 的 PostgreSQL 型別、欄位命名對照、約束、索引、pool 與 migration 落地規範見 16A；實作維持一套 canonical 欄位，不因示例名稱不同而新增重複章號或順序欄位。

| 資料表／集合 | 主要資料 | 重要約束 |
| --- | --- | --- |
| users、sessions | 帳戶、角色、session、撤銷狀態 | 一般會員不能升權；session 可失效 |
| works、volumes | 作品 metadata、類型、連載狀態、edit_version、active_release_id | 編輯版本與公開版本分開 |
| categories、tags | Admin 維護的題材分類、特徵標籤及停用狀態 | 穩定 ID；不以繁簡字串直接當身分；分類與作品類型分開；alias 表與合併對應延後 |
| work_categories、work_tags | 作品與多個分類／標籤的多對多關聯 | 關聯唯一且有反向索引；支持 all／any 全庫篩選；兩種章節匯入均預設保留 |
| chapters | 固定 id、work_id、volume_id、label_raw、editorial_position、head_revision_id | 不以章號作 PK 或唯一鍵；身分不能跨作品錯配 |
| chapter_revisions、chapter_sections | 不可變內容、章名、段落錨點、資源引用、hash、處理版本 | 同一邏輯章可由多個 section 組成 |
| toc_entries | 目錄樹、chapter／section 錨點、顯示標題 | 多個導覽項不重複計正文 |
| source_files、assets | 原檔、hash、storage key、圖片、內容依賴 | 原檔私有，資源清理檢查所有引用 |
| import_jobs、import_items、import_plans | 解析結果、模式、base_version、決策、錯誤與統計 | 每次來源候選有固定 staged_item_id；只套用核准 plan |
| source_mappings | 來源 profile 及人工確認到 chapter_id 的對應 | 作匹配證據，不盲目信任重用 href |
| work_releases、release_items | 公開章節順序與 revision 快照 | 只有完整資源準備好的 release 可切換啟用 |
| user_library、user_follows | 收藏、分類狀態、追更時間 | user_id＋work_id 唯一，二者獨立 |
| reading_progress、user_chapter_reads | 最近游標、同步版本、每章完成紀錄 | 進度不是最大章號；已讀用 chapter_id 記錄 |
| bookmarks、reader_preferences | 多個位置、備註、顯示設定 | 只能讀寫自己的資料 |
| idempotency_records、audit_logs、publication_events | 重試結果、更新前後、首次發布事件 | 操作唯一鍵與事件去重；日誌不保存密碼及 session token |

常用索引包括 work_id＋position、chapter_id＋revision、user_id＋work_id、user_id＋chapter_id、job status＋created_at，以及已發布列表排序。公開列表不讀取正文；章節目錄及 diff 採 cursor／分段查詢，避免 N+1。

## 18｜API 與模組邊界

API 路徑為提案，實作前生成共享型別與驗證 schema。所有狀態變更由後端執行授權、輸入驗證及交易，不信任 client 傳入的章節對應。

v1.1 新增分類／標籤管理、GET /api/works/count、GET /api/me/library，以及多分類／多標籤 all／any query 契約，完整路徑與參數以 03A-F 為準；不得只在前端篩目前一頁。

```
GET    /api/works
GET    /api/works/:workId
GET    /api/works/:workId/toc
GET    /api/works/:workId/releases/:releaseId/chapters/:chapterId
PUT    /api/me/library/:workId
DELETE /api/me/library/:workId
PUT    /api/me/follows/:workId
PUT    /api/me/progress/:workId
PUT    /api/me/chapter-reads/:chapterId
POST   /api/me/bookmarks
PATCH  /api/me/preferences
POST   /api/admin/imports
GET    /api/admin/imports/:importId
POST   /api/admin/imports/:importId/analyze
GET    /api/admin/imports/:importId/items
GET    /api/admin/imports/:importId/items/:itemId/diff
PATCH  /api/admin/imports/:importId/decisions
POST   /api/admin/imports/:importId/plan
POST   /api/admin/imports/:importId/apply
POST   /api/admin/imports/:importId/cancel
POST   /api/admin/imports/:importId/retry
POST   /api/admin/works/:workId/publish
POST   /api/admin/imports/:importId/revert-plan
```

apply 提交 plan_id／plan_version、base_edit_version 及 Idempotency-Key。版本衝突用可識別的 conflict response；解析失敗、格式不支援、配額超限及權限拒絕使用穩定 error code。耗時工作回傳 task handle，查詢狀態可先用有限頻率 polling，不需要為 MVP 引入 WebSocket。

revert-plan 只產生回復預覽，之後沿用受保護的確認與套用機制。發布和下架另有明確管理操作，不能將下載某個資源 URL 等同授權。

## 19｜安全、權限與內容來源

只處理獲准提供線上閱讀的作品，Admin 保存來源與授權備註。網站是否公开及實際版權狀況需在上架前確認；本計劃不代替授權核實，也不提供 DRM 繞過。

上傳只允許必要格式，同時驗證檔案內容與結構，不相信副檔名或 Content-Type。隨機儲存名稱、隔離 staging、限制檔案及實際解壓大小、檔案數、路徑深度、處理時間與 worker 記憶體；阻止路徑穿越、符號連結、ZIP bomb 及重複歧義路徑。官方來源：OWASP File Upload

XML parser 關閉 DTD、外部實體及外部資源解析，並設複雜度／大小限制。官方來源：OWASP XXE Prevention

書內 HTML、SVG／圖片與 CSS 採 allowlist 清理，關閉 script、事件 handler、表單、frame、危險 URL 及遠端資源自動載入；解析 worker 不任意存取外網。必要圖片可轉為受控格式，保留註腳與內部錨點的安全映射。

閱讀器及 Admin 預覽使用同等安全規則，不能只清理前台。epub.js 官方提醒啟用 scripted content 會削弱 sandbox，因此本專案保持停用，並在伺服器清理。官方來源：epub.js Scripted Content

使用成熟身份驗證元件、受保護的 session cookie、CSRF／Origin 驗證、登入與重設密碼限速、管理操作稽核。正式公開註冊前完成帳戶恢復方案；尚無可用寄信服務時先採可控 Beta 註冊，不假裝已完成忘記密碼流程。

原檔與草稿不可公開直讀；已下架正文及舊 revision／release 路徑同樣檢查可見性。Cache-Control 與 CDN 策略必須能配合下架；已被讀者取得的內容不承諾可遠端回收。

## 20｜效能、資源上限與維運

優先讓目前章節可讀，再有限預載下一章；避免整本長篇塞入 DOM。大型章節可按安全段落拆為內部渲染 section，但不額外計成作者章節。目錄、diff、匯入列表虛擬化或分頁，避免一次建立數千 DOM 節點。

改字號、切換繁簡及旋轉螢幕時合併重排工作，等待必要字體／圖片布局穩定後回復錨點；圖片預留尺寸。計算整本頁數不得阻塞開書，頁數明確屬於當前裝置排版。

**初始可配置配額提案：**TXT 30 MiB、EPUB 50 MiB、總解壓 250 MiB、最多 5,000 個封裝資源、每次最多 10,000 個邏輯章節。這些是設計起點，不是已測試容量；上傳前顯示限制。檔案格式、正文大小與圖片解碼亦有單項限制，不能只限制 ZIP 本體。

worker 初版全域併發 1，同作品套用串行化；後續依實測增加，避免 CPU／記憶體壓力影響閱讀 API。所有 lease／timeout／重試與 temporary file cleanup 都需要測試。

**待驗證效能目標：**在記錄清楚的手機、網速、資料量及快取條件下，熱快取開章可操作 P95 目標 1.5 秒內，冷啟動目標 3 秒內；一般 metadata API P95 目標 300 ms 內。未實測不得標為達成；不把解析大型 EPUB 的時間當一般 API latency。

測試集包括百萬字長篇、5,000 章目錄及含圖片／註腳的 EPUB。測量匯入耗時、worker peak RSS、首章可讀時間、翻頁／重排延遲、書架查詢與同步失敗率；建立基準後才決定效能門檻調整。

部署提供 health／readiness、migration、結構化日誌、備份及復原文件。備份涵蓋 PostgreSQL 與被引用內容資源；資料庫本身不可放在未驗證適用性的共享檔案系統。保留策略要保障舊修訂與進度引用，清理採延遲及引用檢查。

## 21｜驗收測試矩陣

以下全部為待執行驗收，不代表已通過。

v1.3 起驗收依 §22A 分三層執行：每次 CI 跑快速自動驗證；階段 gate 跑真 PG／交易／E2E；真機只在 M0／M5／M7。Playwright WebKit 通過不等於 iPhone Safari 真機通過。

v1.2 額外必須執行 16A-K 的 DB-01–DB-08：migration、權限、資料約束、匯入交易、pool／TLS、備份還原及查詢效能，與既有測試共同構成 MVP 驗收。

v1.1 額外必須執行 03A-H 的 CAT-01–CAT-12：分類、標籤、多選 all／any、複合條件、URL、手機操作、匯入保護、權限及 cache。這些與下表共同構成完整 MVP 驗收，不可只驗收舊案例。

| ID | 案例 | 必要結果 |
| --- | --- | --- |
| IMP-01 | 首次匯入 1–180 | 建立 180 個章節，目錄與首尾內容正確 |
| IMP-02 | 再匯入 1–190，增量 | 只新增 10；舊章有修訂也保留並提示 |
| IMP-03 | 再匯入 1–190，4 個舊章有改，覆蓋 | 新增 10、更新 4、相同跳過 176，舊 chapter_id 不變 |
| IMP-04 | 新版含 87.5 | 中間新增，總數按實際筆數；不能只 append |
| IMP-05 | 12.1、12.10、12.5.1、12.50、上下篇 | 原標籤完整保存，不截斷、不按浮點合併 |
| IMP-06 | 不同卷都有第 1／12.5 章 | 不跨卷誤配 |
| IMP-07 | 只上傳 181–190 或單獨番外 | 足夠錨點則追加；不確定位置需確認 |
| IMP-08 | 新檔只有 1–170 | 兩種模式均保留既有 171–180 |
| IMP-09 | 同檔先增量後覆蓋 | 允許新 plan 套用舊章修訂，不重複建章 |
| IMP-10 | 相同 apply request／worker 重送 | 返回同一結果，只提交一次 |
| IMP-11 | 預覽後另一 Admin 修改 | 阻止 stale plan，要求重新比對 |
| IMP-12 | 解壓、解析或 commit 前故障 | 正式內容不半新半舊，重試可追溯 |
| IMP-13 | commit 成功但 response 丟失 | 重試找到已提交結果，不再套用 |
| IMP-14 | Big5／GB18030／UTF-16、混合換行 | 可覆核與重選編碼，不靜默匯入亂碼 |
| IMP-15 | 目錄重複標題、正文提及章號、無章節長文 | 不誤拆或無聲丟文，支援人工修正 |
| IMP-16 | EPUB 檔案順序與 spine 不同 | 按正確閱讀順序，目錄不重複正文 |
| IMP-17 | 同正文但圖片／註腳目標有改 | 辨識內容修訂並帶齊資源 |
| IMP-18 | 重編號、改名、拆章／合章、繁簡不同來源 | 有候選與衝突，不靜默誤覆蓋 |
| VER-01 | 修訂前已有進度及書籤 | 章節 ID 保留；同章近似回復至 paragraph_index 或章首並提示 |
| VER-02 | 回復舊匯入但已有後續修改 | 不撤銷後來改動；明確提示版本已變，Admin 手動處理 |
| PUB-01 | 匯入草稿、修正錯字、新章發布 | 只有新章首次公開觸發追更 |
| PUB-02 | 讀到 180 後發布 87.5 | 顯示未讀新章，繼續閱讀仍回 180 原位置 |
| READ-01 | 字號、繁簡、橫直屏切換 | 回到同段落，正文不被底部工具列遮住 |
| READ-02 | 手機選字、註腳、返回、深色及大字 | 不誤翻頁、無困住焦點或不可操作按鈕 |
| READ-03 | 兩裝置及延遲同步 | 舊進度不靜默覆蓋新位置 |
| SEC-01 | ZIP slip／bomb、XXE、script／SVG、外部 CSS | 被拒絕或安全處理，不執行及不外連 |
| SEC-02 | 普通會員操作 Admin、他人書籤、草稿／下架 URL | 後端拒絕，不能靠猜 ID 越權 |
| OPS-01 | 備份復原及孤立資源清理 | 公開正文與版本引用仍完整 |

必測裝置：iOS Safari、Android Chrome、Desktop Chrome／Firefox，含真機測試；桌面模擬器縮窄不等於手機驗收。Fixtures 使用自製或獲准內容，保留預期章節與 diff golden files。

## 22｜完整開發路線與階段出口

v1.2 資料庫工作分配：M1 完成 DB-T1／DB-T2 的環境、權限、schema／migration 與 pool；M4 完成 DB-T3 的匯入交易及冪等故障驗收；M7 完成 DB-T4 的壓測、TLS／權限回歸與完整備份還原。所有項目與驗收定義見 16A-K。

各階段以可驗證成果作 gate，不在沒有估算依據時承諾日程。所有階段初始狀態為 Todo。

## 22A｜分層驗收（v1.3 新增）

**新增日期：2026-09-28｜狀態：Todo。**

| 層 | 內容 | 執行時機 |
| --- | --- | --- |
| L1｜快速自動驗證 | 單元測試、型別檢查、lint，及純邏輯驗收（章號解析、matching 規則、filter predicate、排序計算） | 每次 CI／每次 push |
| L2｜階段 gate 驗證 | 真 PostgreSQL、交易與冪等／故障注入、API E2E、匯入全流程 | 每階段（M1–M7）出口 |
| L3｜真機驗證 | iOS Safari、Android Chrome 實機閱讀與匯入預覽流程 | 僅 M0、M5、M7 |

Playwright WebKit 通過不等於 iPhone Safari 真機通過；桌面模擬器縮窄也不替代 L3。各驗收 ID 按 §21 說明歸層：READ-01／02、READ-03 的實機部分及 M0 閱讀 gate 屬 L3，其餘優先以 L1／L2 自動化覆蓋；無法自動化的案例在各階段 gate 以手動清單執行並記錄。

| 階段 | 交付 | 完成標準／依賴 |
| --- | --- | --- |
| M0｜規格及高風險 POC | 固定匯入契約、樣本 fixtures、不規則章號測試；epub.js 與 foliate-js 雙候選閱讀 POC（同環境同真機比較，選後只整合一個）／繁簡／安全隔離小型驗證 | 確認來源到內部模型可行，12.10 不被數值化；手機能按章閱讀並回段落；閱讀引擎擇一並記錄比較結果 |
| M1｜基礎工程 | repo、CI、環境設定、PostgreSQL 18／Drizzle／pg.Pool、低權限 roles、migration、核心 schema 與約束、Admin 身分與授權、private storage、worker 骨架；執行 DB-T1／DB-T2 | 非 Admin 無法上傳；本機可啟動；失敗日誌可追溯；DB-01／DB-02／DB-03 基礎案例通過，runtime 不跑 DDL |
| M2｜首次匯入 | TXT／EPUB parser、安全檢查、編碼預覽、分章修正、staging、草稿內容瀏覽 | IMP-01、14–16 與核心安全樣本通過，不跳過 EPUB |
| M3｜增量與中間插章 | 匹配規則、diff preview、人工解歧義、完整／局部追加、排序預覽 | IMP-02、04–08、18 通過，不重複建章、不以最大章號判新章 |
| M4｜覆蓋與可靠套用 | 不可變修訂、覆蓋更新、版本衝突、冪等、重試、受保護回復（發布快照屬 M6，隨發布 API 實作） | IMP-03、09–13、VER-01／02 通過，故障不破壞正式內容；IMP-17 資源感知部分延後（見 §23 ADR-08） |
| M5｜手機閱讀器 | 底部控制、bottom sheet、分頁／捲動、繁簡、主題字號、目錄、段落定位 | READ-01／02 在實機通過；百萬字不全塞 DOM |
| M6｜書庫、會員與追更 | 短篇／連載入口、搜尋、分類／標籤、多標籤 all／any 與複合篩選、底部篩選面板、註冊登入、收藏、書架、書籤、進度同步、已讀及更新標記 | READ-03、PUB-01／02、CAT-01–CAT-12 與會員權限案例通過；taxonomy 基礎及匯入保護按 03A-G 在 M1／M2 先建立，效能／安全回歸於 M7 收尾 |
| M7｜Beta hardening | 全測試矩陣、效能量測、安全回歸、備份復原、監測、部署及管理手冊 | 無阻塞級錯配／資料遺失／越權；Beta runbook 可照做 |

**第一條端到端交付線：**Admin 首次匯入 1–180 → 手機閱讀並保存位置 → 新檔案 1–190＋87.5 → 差異預覽 → 選增量或覆蓋 → 明確發布 → 手機仍回原章原段，書架正確顯示新章。

閱讀 POC 可以與 import schema 並行探索，但完整首頁美化不能取代 M2–M4 的匯入驗收。

## 23｜決策紀錄、風險與未決事項

**ADR-01：章號是標籤，不是數值身分。** 原字串保留，穩定 chapter_id 與 position 分離。

**ADR-02：增量允許任何位置加入新章。** 不使用「新編號大於最大舊章號」作判定。

**ADR-03：覆蓋建立修訂，不重建章節。** 預設不刪來源缺失章、不改無關 metadata。

**ADR-04：章節式內部模型是資料真相。** 修正早期「TXT 統一轉整本 EPUB」的過度簡化；EPUB 可作輸入及衍生渲染格式，但不支配匯入、版本及進度。

**ADR-05：不依賴 AI 判斷章節身分。** 自動規則需可解釋；疑義人工確認，容許慢一點但不容許靜默錯覆蓋。

**ADR-06：預覽及套用分離，發布再分離。** 所有正式更新可追溯並具版本檢查。

**ADR-07（2026-10-01）：生產閱讀器採 canonical chapter renderer，不整合 epub.js／foliate-js。** canonical body 已是 TXT/EPUB 統一的純文字段落序列（`\n\n` 連接），引擎的 EPUB 包概念（spine/CFI）在 canonical 模型中不存在；引入引擎只會造成 TXT/EPUB 雙讀取路徑與定位契約衝突。原 §16「閱讀引擎擇一」需求由此 ADR 取代，M0 真機雙引擎比較失去必要性；真機驗證義務轉移至 M5 生產閱讀器 L3（`docs/adr/l3-device-checklist.md`）。詳見 `docs/adr/adr-07-reader-architecture.md`。

**ADR-08（2026-10-01）：IMP-17 資源感知修訂偵測延後。** IMP-17 要求「同正文但圖片／註腳目標有改須判為修訂」；現行 canonical model 在 EPUB 解析時即拍平為純文字（M2 已知限制：圖片資源不映射、list 不萃取），資源層根本不存在，無從偵測。資源感知修訂依賴：EPUB parser 資源萃取＋`chapter_revision_resources` 式不可變資源關聯＋閱讀器安全渲染——三者在同一管線改動中補齊（併入圖片支援的 ingestion 工作，最早 M6 前處理）。在該管線完成前，IMP-17 不得標記為通過。

主要風險：來源編碼／格式不一致、章節拆合、相同標籤、第三方閱讀器安全與手機兼容、大型 EPUB 資源消耗、內容授權。對策分別為預覽覆核、結構衝突、穩定 ID、adapter POC、安全配額與上架前來源確認。

未決但不阻擋開工：正式名稱與網域、公開或邀請 Beta、寄信服務（目前傾向以邀請碼註冊取代電郵驗證）、初始書籍數量／最大檔案、是否需要台灣字形、最終閱讀 adapter（由 M0 雙候選 POC 決定）。未有明確決策前使用本文件預設，不能偷偷擴大範圍。

v1.3 已明確延後的 backlog 項目：分類／標籤合併機制與 alias 表、回復補償計劃自動化、篩選面板 debounce 即時總數、文字 fingerprint／字元級跨修訂映射。

## 24｜開工清單與交付要求

- [ ]  建立新 repository 與 README，記錄本文件為需求基線；不假設已有程式。
- [ ]  建立 1–180、1–190、1–190＋87.5、有四章修訂、局部檔案與奇怪章號的合成 fixtures。
- [ ]  先為 matching／ordering／idempotency 定義可重複的預期結果，再鋪管理 UI。
- [ ]  M0 以 epub.js＋foliate-js 雙候選驗證閱讀 adapter（同環境、同真機比較後擇一）、繁簡及手機段落定位，鎖定依賴與測試範圍。
- [ ]  依 M1–M7 推進，每階段附實際執行命令、測試結果、失敗項及未驗證限制。
- [ ]  Beta 前完成一輪完整匯入、更新、發布、回復與備份還原演練。

Agent 實作時使用繁中 UI／文件、English code comments；採小步可審查變更，避免無關重構。不得把 mock、靜態分析或文件存在當作真機／實際測試通過，不以「可用 library」代替需求驗收，不擅自新增付費服務或內容抓取來源。

**Definition of Done：**功能符合模式契約，資料一致性與安全測試通過，手機主要流程可用，失敗可診斷及恢復，部署與維運步驟有文件，且所有未測項目被明確列出。

## 25｜來源與文件維護

需求來源為 2026-09-28 本次對話，包含手機底部控制、短篇／連載、1–180 更新至 1–190 的增量／覆蓋，以及小數章號要求。工程規格是本計劃提出的實作設計，並非第三方產品已提供的整套能力。

技術依據已在相關段落直接連結至 W3C、epub.js、opencc-js、iconv-lite、OWASP 及 PostgreSQL 官方文件。v1.2 亦補入 Drizzle、node-postgres、PostgreSQL 官方 Docker image 與 DBeaver 文件，並核對連線、TLS、初始化路徑、migration 及權限注意事項。這些來源說明格式／元件與安全機制，不代表本專案已完成相容性、效能或安全驗收；實作時重新確認選定版本及依賴授權。

版本紀錄：v1.0／2026-09-28，整合完整產品、匯入核心、資料模型、手機 UX、開發路線與驗收矩陣。

v1.1／2026-09-28：根據使用者新增需求，納入作品分類、標籤、可多標籤 filter；補齊多分類、all／any 契約、手機底部篩選、後台管理、匯入 metadata 保護、schema／API、CAT-T1–T5 工作與 CAT-01–CAT-12 驗收。只更新規格，工程狀態仍為 Planning／Todo。

v1.2／2026-09-28：按使用者要求把資料庫方案納入計劃，定下 PostgreSQL 18＋Drizzle ORM＋pg.Pool／Drizzle Kit，新增 16A 的 database／schema、章節型別與完整性約束、內容儲存分工、Docker 初始設定、低權限帳戶、TLS、連線模組參考、migration、DBeaver SSH、備份還原、DB-T1–T4 及 DB-01–DB-08；同步更新架構、M1／M4／M7 與驗收入口。未建立 DB、執行 migration 或部署。

v1.3／2026-09-28：review 後採納三項調整：一、M0 閱讀引擎改為 epub.js＋foliate-js 雙候選 POC，同環境同真機比較後只整合一個；foliate-js 同樣基於 iframe＋CSS multi-column 且 API 未穩定，epub.js 需記錄 npm 版本與 upstream commit 差異。二、閱讀定位收斂為 chapter_id＋revision_id＋paragraph_index，跨修訂只做近似回復＋提示，文字 fingerprint／字元級映射移入 backlog，書籤永久保留原始定位數據。三、新增 §22A 分層驗收（CI 快速驗證／階段 gate 真 PG 交易 E2E／真機僅 M0、M5、M7）。同時延後：分類標籤合併機制與 alias 表、回復補償計劃自動化、篩選面板 debounce 即時總數；相應修訂 03A、14、16、17、18、21、23、24 及 CAT／VER 案例。仍屬 Planning／Todo，未開始實作。

後續需求變更先更新行為契約及測試，再更新實作任務。

**目前工程進度：見 §26；本節原「工程未開始」已由 §26 取代。**

## 26｜實際工程進度（滾動更新）

**更新日期：2026-09-29。** 本節取代文件內所有「工程未開始」的舊敘述；規格任務清單的 checkbox 不逐一回填，以本節為唯一進度真相。

| 階段 | 狀態 | 備註 |
| --- | --- | --- |
| M0（規格及高風險 POC） | 程式／POC 完成 | 雙引擎 POC、不規則章號解析器、合成 fixtures 均在 `m0/`；原雙引擎 L3 真機比較由 ADR-07 取代，真機驗證義務轉移至 M5 生產閱讀器 L3 清單（`docs/adr/l3-device-checklist.md`，未執行） |
| M0 閱讀引擎最終擇一 | 由 ADR-07 取代（2026-10-01） | 生產閱讀器採 canonical chapter renderer，不整合 epub.js／foliate-js（見 §23 ADR-07）；M0 雙引擎真機比較失去必要性，POC 保留於 `m0/` 作歷史參考 |
| M1（基礎工程） | 完成，本機已驗證 | DB-01／02／03、非 Admin 403、本機啟動、CI L1＋L2（詳見 README） |
| M2（首次匯入） | 完成（2026-09-29） | TXT 全流程＋**EPUB 解析完成**：container→OPF→spine 閱讀順序（非檔名順序）、nav/NCX 標籤、DOMPurify allowlist 清理、zip bomb（壓縮比/總量/條目上限）與路徑穿越防護、spine 重複去重、非文字節 needsReview。L2 e2e 7/7（含 IMP-16 上傳→解析→預覽→commit spine 順序 5 章）；單元 8/8。已知限制：一個 XHTML 多章錨點不拆分（標記 backlog）、list 內容暫不萃取、圖片資源暫不映射（M5 閱讀器前處理） |
| M3（增量與中間插章） | 完成（2026-09-29） | 匹配引擎（`match.ts`：label key 唯一→自動匹配；重複/改名→ambiguous；重編號/拆合章→structural_conflict；錨點插入；無錨點→需確認，ADR-02）＋增量套用（交易內 job 鎖→作品鎖→`base_edit_version` 檢查→錨點插入＋DEFERRABLE 位移→`edit_version` 遞增；modified 保留站方版本 §05；冪等重放；`resolutions`/`confirmAppend` 人工決策）。API：`GET /:id/diff`、`POST /:id/apply`；UI 加目標作品＋比對＋套用。Gate 全過：單元 10/10（IMP-02/04/06/07/08/18 形狀）、e2e 13/13（IMP-02+04：+11 含 87.5 中插、ID 不變；IMP-07 confirmAppend；IMP-08 保留 171–180；IMP-18 重編號擋截＋Admin 解決；冪等；版本衝突 409）。過程修復：full-190 fixture 原本漏第 87 章（引擎正確地報衝突，fixture 錯） |
| M4（覆蓋與可靠套用） | 完成（2026-10-01） | apply 支援 `mode: incremental/overwrite`：覆蓋為匹配章建立**新不可變修訂**（chapter_id 不變、head 前移，ADR-03）；`Idempotency-Key`（`apply_idempotency` 表與內容變更同交易：同 key 同 payload 回放、同 key 異 payload 409）；apply 持久化回復快照（addedChapterIds＋revisionChanges）；`POST /:id/revert-plan`＋`POST /:id/revert` 受保護回復（僅當作品仍在該版本；後續修改 → 409 revert_conflict，補償自動化屬 backlog v1.3）；狀態機加 `reverted` 終態。Gate e2e（serial 執行）：IMP-03（+11 更新 4 跳過 176、雙修訂、舊修訂不變）、IMP-09（同檔先增量後覆蓋 195 修訂）、IMP-10/13（冪等鍵重放＋衝突）、IMP-11（M3 版本衝突 409）、IMP-12（M2 故障回滾，共用交易層）、VER-01（chapter_id 穩定）、VER-02（後續修改擋回復＋正確回復＋冪等重放）。e2e 17/17（×3 連跑穩定）。**未含**：work_release 發布快照——發布 API 屬 M6（§13），無發布流程的 release 表是死 schema，於 M6 一併實作 |
| M5（手機閱讀器） | 實作完成（2026-10-01），**L3 真機待驗，未完全驗收** | 架構：ADR-07 canonical chapter renderer（不整合 epub.js／foliate-js；M0 雙引擎擇一由 ADR 取代）。後端：`GET /api/reader/works/:id`、`GET /api/reader/works/:id/chapters`（TOC 分頁 ≤500、不規則標籤逐字保留、不含 body）、`GET /api/reader/chapters/:id`（僅 head 修訂、前後章、段數；`content_unavailable` 409）；可見性 draft=Admin 預覽 403、public/unlisted 開放、removed=404；DTO 不洩漏 storage/import 欄位；e2e 6/6。前端：`apps/web/src` 重構為 App/api/admin/reader/styles；閱讀器一次一章、段落＝純文字節點（canonical body 為 `\n\n` 段落，sanitize 契約見 ADR-07）；位置契約 `chapter_id+revision_id+paragraph_index`（scroll 另帶 fraction），修訂變更 clamp＋可察覺提示，頁碼永不持久化；捲動＋分頁（CSS multi-column）共用錨點工具，模式往返記住 scroll 錨點；字號/行距/段距/繁簡/模式變更兩段 rAF 重錨；繁簡 opencc-js 檢視期逐段轉換（lazy chunk，canonical 永不回寫）；三主題；44px 觸控目標、safe-area、bottom sheet（TOC 視窗化 100/批）、焦點管理、選字不誤觸；chrome 開啟推開內容不遮蓋；設定與位置存 localStorage（M6 前不建 server 端進度）。瀏覽器驗收 6/6（Playwright 390×844，×3 連跑穩定）；單元 9/9。**未做**：真機 L3（`docs/adr/l3-device-checklist.md`，18 項未執行）；圖片／註腳（canonical 模型未保留資源，併入 ingestion 工作，ADR-08）；百萬字長章僅以 800 段單章驗證 bounded rendering |
| M6（發布＋書庫＋會員） | 實作完成（2026-10-01） | **發布**：`work_releases`（work+version 唯一、Idempotency-Key 冪等）＋`release_items`（chapter+release 主鍵、不可變 revision 快照、位置唯一）＋`works.active_release_id` 複合 FK（migration 0004/0005）；`POST /api/admin/works/:id/publish` 顯式發布（鎖作品→驗證〔標題/類型/連載狀態/章節/head 修訂/內容物件/首次發布需分類〕→快照→事件→原子切換；失敗舊 release 不動）；公開讀者一律讀 release 快照——匯入/覆蓋後 head 變更對公眾不可見直到發布（e2e 驗證），無 release 的公開作品暴露零內容；Admin head 預覽走 `/api/admin/preview/*`；M4 revert 遇快照引用改 409 `revert_published`（§47 回歸）。**事件**：`publication_events` 每 release 一筆，NEW=前版無此章、UPDATED=修訂變更、只 NEW 計追更新章（PUB-01：勘誤不觸發新章事件；PUB-02：後發布的 87.5 對讀到 180 的會員是新章且「繼續閱讀」仍回 180——進度以 chapter_id 為身分）。**書庫**：`GET /api/works`（visibility=public＋active release；關鍵字〔書名/作者/分類/標籤，繁簡變體查詢期轉換〕、類型、分類 OR、標籤 all/any、連載狀態 OR、排序、limit≤50 分頁；0 結果如實回 0）；`/api/works/count`、`/api/works/:id`、`/api/taxonomy/:kind`。**taxonomy**：Admin CRUD＋作品指派（分類≤5、標籤≤20、停用不可新指派、既有關聯保留）；匯入/套用不動 taxonomy/發布/會員狀態（回歸測試）。**會員**：`REGISTRATION_MODE`（預設 closed，Beta 用 invite：token 僅存 sha256、單次使用與建號同交易）；書庫/追更/已讀/書籤/偏好分表獨立，取消收藏/追更不刪其他狀態；`reading_progress` 樂觀並發（`baseVersion`→`sync_version+1`，409 回伺服器位置；可重讀舊章）；`user_chapter_reads` 以 chapter_id 記已讀；書籤凍結 revision；偏好 1 人 1 列。**閱讀器整合**：會員進度 8 秒去抖寫入＋換章/隱藏 flush；409 時採帳號位置並提示；訪客本機保留；已讀=停留在章 10 秒（預取不記）。**CSRF**：同 host＋`CSRF_ALLOWED_ORIGINS`（代理部署用）。**UI**：書庫/詳情/我的書庫/書籤/登入/邀請註冊/管理後台（發布預覽面板＋taxonomy 管理）；篩選狀態入 URL 可分享。Gate：全新 PG 18 0000→0005 遷移＋驗證通過；server e2e 42/42（publishing 6＋taxonomy 6＋member 7＋既有 23）；瀏覽器 12/12×3（catalog 3＋member 3＋M5 reader 6）。**未做**：真機 L3（仍待驗）、圖片/註腳資源（ADR-08 遞延）、open 註冊（無密碼復原不開放）、分散式限流（M7） |
| M7 | 未開始 | Beta hardening |
