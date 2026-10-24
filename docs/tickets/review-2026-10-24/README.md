# 2026-10-24 檢視 tickets（SEO、匯入、內容營運）

建立日期：2026-10-24。來源：`e223d00` 為基線的唯讀檢視，重點為 SEO 面，另加兩項使用者回報（括號編號分段失敗、刪除／重新匯入的入口）。基線 `pnpm lint`、`pnpm typecheck`、`pnpm test`（server 137 項）通過。

本批共 18 張 tickets。RV-001～RV-011 來自檢視與回報的缺陷，RV-012／RV-013 是使用者提出的功能需求。

**2026-10-24 實作狀態**：RV-002、RV-004～RV-009 完成；RV-001、RV-003、RV-010 部分完成（各票「實作結果」列明未完成項）；RV-011 完成但有兩項驗收條件未達成；RV-012、RV-013 未開始（兩者都需要先確認票內的決策）。所有 Playwright e2e spec 已寫但**未執行** —— 需要 dev server 與 API。

## 優先級與嚴重度

沿用 [2026-10-19 批次](../codebase-review-2026-10-19/README.md) 的定義：

- **嚴重度**：對 production 正確性、可被搜尋到的程度或內容營運的影響。
- **優先級**：P1／P2／P3 為排程次序，不是事故嚴重度。
- **AFK**：範圍已具體化，可由 agent 接手；**HITL**：實作前需要人工確認票內列出的決策。
- 工作量為相對估計，非工期承諾。

## 索引

| ID | Ticket | 範疇 | 嚴重度 | 優先級 | 工作量 | 類型 | 狀態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RV-001 | [消除 soft-404 與自我 canonical](RV-001-soft-404-canonical.md) | SEO | 極高 | P1 | 中 | HITL | 部分完成 |
| RV-009 | [括號編號以外的分段標記仍會令整本變成一章](RV-009-bracket-chapter-headings.md) | 匯入 | 高 | P1 | 中 | AFK | **implemented-local** |
| RV-002 | [章節 sitemap lastmod 改用章節自身的時間](RV-002-chapter-lastmod.md) | SEO | 中高 | P2 | 中 | AFK | **implemented-local** |
| RV-003 | [加入 JSON-LD 結構化資料與分享圖](RV-003-structured-data.md) | SEO | 中高 | P2 | 中 | HITL | 部分完成 |
| RV-010 | [刪除作品：可發現性、復原與永久清除](RV-010-delete-work-lifecycle.md) | 內容營運 | 中高 | P2 | 中 | HITL | 部分完成 |
| RV-011 | [重新匯入：補上可用的入口](RV-011-reimport-entry-point.md) | 內容營運 | 中高 | P2 | 中 | AFK | **implemented-local** |
| RV-004 | [閱讀器 head 未跟隨語言切換](RV-004-reader-head-locale.md) | SEO | 中 | P2 | 小 | AFK | **implemented-local** |
| RV-005 | [head.ts 的正確性缺口與零測試覆蓋](RV-005-head-correctness-tests.md) | SEO | 中 | P2 | 小至中 | AFK | **implemented-local** |
| RV-006 | [sitemap 空 urlset 與 count／join 不一致](RV-006-sitemap-empty-urlset.md) | SEO | 低至中 | P3 | 小 | AFK | **implemented-local** |
| RV-007 | [SITE_ORIGIN 缺 drift guard，robots.txt 前綴不一致](RV-007-site-origin-guard.md) | SEO | 低 | P3 | 小 | AFK | **implemented-local** |
| RV-008 | [為兩份 slug.ts 加 drift guard](RV-008-slug-drift-guard.md) | SEO | 低 | P3 | 小 | AFK | **implemented-local** |
| RV-012 | [詳細閱讀時間與數據統計](RV-012-detailed-reading-stats.md) | 功能 | 不適用 | P2 | 中至大 | HITL | open |
| RV-013 | [閱讀時的人名替換與角色互換](RV-013-name-substitution.md) | 功能 | 不適用 | P3 | 中 | HITL | open |
| RV-014 | [自動滾動與自動翻頁](RV-014-auto-scroll.md) | 功能 | 不適用 | P2 | 中 | AFK | **implemented-local** |
| RV-015 | [劃線、筆記標籤與筆記匯出](RV-015-highlights-notes-export.md) | 功能 | 不適用 | P2 | 大 | HITL | open |
| RV-016 | [藍光濾鏡與定時切換主題](RV-016-eye-comfort.md) | 功能 | 不適用 | P3 | 小至中 | AFK | **implemented-local** |
| RV-017 | [可自訂的觸控區域](RV-017-custom-tap-zones.md) | 功能 | 不適用 | P3 | 中 | HITL | open |
| RV-018 | [PWA：可安裝、app shell 與 service worker](RV-018-pwa.md) | 平台 | 不適用 | P2 | 中 | AFK | **implemented-local** |

## 建議執行次序

1. **RV-009**：使用者回報的實際匯入失敗，整本變一章是不可接受的結果，且與 RV-011 的匹配品質直接相關。
2. **RV-001（head 層）**：目前每一條不存在的 URL 都是一份自我 canonical 的 catalog 複本，收錄污染會隨時間累積。status 層可後續再決定。
3. **RV-011 → RV-010**：兩者都是「能力已存在但找不到入口」。重新匯入先做，因為沒有它，更新一本書的替代做法會產生重複作品。
4. **RV-004 + RV-005 + RV-003**：三票都動 `head.ts`，合併一次處理，避免反覆衝突。
5. **RV-002**：lastmod 失準會令搜尋引擎逐步不再採信 sitemap。
6. **RV-006 → RV-007 → RV-008**：一致性與 guard 的收尾工作。
7. **RV-018 → RV-014 → RV-016 → RV-017**：平台與閱讀體驗。RV-018 先做，因為它同時是 ER-007 離線章節的前置；RV-014 收益最明顯且範圍最乾淨。
8. **RV-012、RV-013、RV-015**：三者都需要先確認票內列出的決策才動工。RV-012 需要 schema 變更（時間歸屬到作品）；RV-013 與 RV-015 共用同一個「顯示文字 ≠ canonical 文字」的偏移映射問題，建議同一輪處理。

## 功能清單的查核結果（2026-10-24）

使用者提出的閱讀器功能清單，逐項對照現狀：

**已經有，不開票** —— 智能段落裁切（`admin/tidy-txt.ts`：去空白、合併空行、移除推廣行與裸 URL、接回硬斷行；但僅限「批量匯入」面板、僅 TXT、僅 admin 匯入時）、簡繁一鍵轉換（`reader/conversion.ts`，view-time、段數不變，搜尋亦支援繁簡互查）、TTS 朗讀（語速／聲音／自動下一章／逐段高亮）、日夜主題（light／sepia／dark／system）、書籤與批註（段落級、revision 凍結，ER-003 已交付）。

**暫緩，待平台方向確認** —— 第三方字典連動（ColorDict／Mdict／GoldenDict 靠 Android intent IPC，瀏覽器無此機制；web 的替代是自建字典資料或長按開外部查詢 URL，不是同一回事）、音量／電源／相機鍵翻頁（瀏覽器收不到這些按鍵；**藍牙鍵盤與簡報器已經可用**，因為它們發的是普通 key event，而方向鍵／空白／PageUp/Down 已由 `use-reader-keyboard.ts` 支援）、筆記直接寄到電子信箱（需要伺服器寄信管道；`mailto:` 帶不動附件）。維護者已表示有機會包成 native／PWA，故記為暫緩而非永久不適用；PWA 本身是 RV-018，但 PWA 並不解決字典 IPC 與音量鍵。

**做不到，已在相關票內寫明** —— 環境光自動切換主題（Ambient Light Sensor 因側信道風險已被各瀏覽器移除，見 RV-016）、系統亮度調整（見 RV-017）。

## 票與票之間的關係

- **RV-003／RV-004／RV-005**：全部改動 `apps/web/src/lib/head.ts` 的同一段 upsert／清除邏輯。RV-005 先補測試，另外兩票在有測試的基礎上進行。
- **RV-001／RV-008**：若 RV-001 的 status 層選擇 nginx 前綴白名單，該白名單與 `parsePath` 之間需要 drift guard，可沿用 RV-008 建立的手法。
- **RV-009／RV-011**：分段產生不了編號 `key` 時，重新匯入會把整批章節判成新增。RV-009 先做可令 RV-011 的匹配品質明顯較好。
- **RV-010／RV-011**：兩票的根因相同 —— 後端能力完整，但 admin UI 沒有相稱的入口。建議同一輪處理，令「更新一本書」與「移除一本書」在介面上是對稱的。
- **RV-007／CR-001**：CR-001 已處理可信 client IP；本票只補 `SITE_ORIGIN` 的 manifest guard，不重做信任鏈。

## 與既有批次的關係

- `codebase-review-2026-10-19`（CR-001～CR-013）：已 `implemented-local`。本批不重複其任何範圍；RV-004 明確依賴 CR-010 引入的 `react-hooks/exhaustive-deps`，並說明為何該規則捉不到這個個案。
- `reader-improvements`（ER-001～ER-012）：ER-010 已交付匯入覆核介面，RV-011 只補它的入口，不改其語義。

## 共通驗證

每張 AFK ticket 完成時至少需要：

```sh
pnpm lint
pnpm typecheck
pnpm test
```

涉及資料庫、匯入、發布或 sitemap 契約的 ticket 另需 `pnpm --filter server test:e2e` 與 `pnpm db:verify`；涉及 admin 或閱讀器互動的 ticket 另需 `pnpm --filter web test:browser`。真機 L3 不會被瀏覽器自動化取代，未執行項目須如實記錄。
