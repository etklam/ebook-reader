# RV-014｜自動滾動與自動翻頁

- 嚴重度：不適用（功能需求）
- 優先級：P2
- 工作量：中
- 類型：AFK
- 狀態：open

## 要做的事

讓讀者開啟自動捲動（捲動模式下平滑前進）或自動翻頁（分頁模式下定時換頁），速度可調，讀長章時不用一直碰螢幕。

## 分析

### 現狀

全 repo 沒有任何自動捲動或定時翻頁的實作。既有的只有手動路徑：`use-reader-keyboard.ts` 的鍵盤捲動、`ReaderPage` 的點擊帶與滑動翻頁、`SpeechControls` 的朗讀（含自動下一章）。

### 這個功能會撞到的既有契約

這不是「加一個 `setInterval` 捲動」那麼簡單，閱讀器有三條規則會被它碰到：

1. **內容刻意不做動畫。** `use-reader-keyboard.ts:24-28` 寫明：DESIGN.md 要求正文不做動畫，因為錨點要可量測；而且長章仍在排版時，瀏覽器會靜默丟棄 `behavior: 'smooth'`。所以自動捲動不能用 `scrollBy({ behavior: 'smooth' })` —— 它在最需要它的情況（長章剛載入）下會什麼都不做。做法應該是 `requestAnimationFrame` 每幀推進 `scrollTop`，速度以 px/秒 定義並乘以幀間隔，這樣速度與螢幕更新率無關。

2. **錨點與進度同步。** `captureScrollIndex`（`position.ts:16`）每次都重新讀幾何來決定「正在讀哪一段」，而進度同步是 8 秒 debounce、換章或頁面隱藏時 flush（`member-sync.ts:1-6`）。自動捲動會令錨點持續移動，等於把一個本來由使用者動作觸發的節流器變成持續觸發。必須確認：自動捲動期間的進度寫入頻率不高於手動閱讀，否則一本書讀一小時就是幾百次 `saveProgress`。

3. **章末行為。** 捲到章末要停、還是自動載入下一章繼續？`chapter-loader.ts` 的 `shouldPrefetchNext` 已經會預載下一章，所以接續在技術上是通的。但「自動」加「換章」等於讀者沒碰過任何東西而書已經翻過一章 —— 這需要是明確選項，不是預設。

### 必須一併處理

- **螢幕不能熄。** 自動捲動的賣點是解放雙手，而手機幾十秒就熄屏。需要 Screen Wake Lock API，並在分頁隱藏時釋放、回來時重取（瀏覽器會自動釋放）。不支援 Wake Lock 的瀏覽器要誠實說明，不要假裝有。
- **任何互動要暫停。** 觸碰、捲動、開啟任何面板都應暫停而不是取消，並給一個明顯的恢復入口。讀者抬頭看一眼就丟失位置是最差的結果。
- **與朗讀的關係。** TTS 已經會逐段高亮（`ReaderPage:586` 的 `highlightSpeech`）。朗讀開啟時，捲動應該跟隨朗讀位置，而不是兩個速度各自前進打架。至少要定義為互斥。
- **分頁模式。** 分頁模式沒有「捲動速度」，只有「每頁停留秒數」。兩種模式的設定不是同一個數值，UI 不應假裝是。

### 建議做法

新模組 `apps/web/src/reader/auto-advance.ts`：純函式／hook，輸入目前模式、速度、暫停狀態，輸出每幀位移或下一次翻頁時刻。與 `conversion.ts`、`pagination.ts` 同樣保持可在 node 測試。速度存進 `ReaderSettings`（會經既有偏好同步到帳號）。

## 驗收條件

- [ ] 捲動模式下可開關自動捲動，速度可調，且速度與螢幕更新率無關（高更新率螢幕不會捲得更快）。
- [ ] 分頁模式下可開關自動翻頁，停留秒數可調；兩種模式的設定值各自獨立。
- [ ] 自動捲動期間的進度寫入頻率不高於手動閱讀，並有測試或量測佐證。
- [ ] 任何讀者互動暫停而非取消；恢復入口明顯，位置不丟失。
- [ ] 啟用期間取得 Screen Wake Lock，分頁隱藏時釋放、回前景時重取；不支援的瀏覽器明確告知而非靜默失效。
- [ ] 章末行為（停止／續讀下一章）是明確選項，預設為停止。
- [ ] 朗讀與自動捲動的關係已定義並實作（跟隨或互斥），不會兩個速度打架。
- [ ] 長章（10 萬字）啟用時無可觀察的掉幀，沿用 `apps/web/scripts/reader-performance.mjs` 量測，結果記入 `docs/perf/`。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm --filter web test:browser` 通過。

## 不在範圍

跑馬燈式的逐字／逐行捲動（與段落錨點契約衝突，需另行評估）、速度隨內容自動調整。

## 依賴

無。與 ER-011（捲動效能）相關：自動捲動會持續觸發同一條路徑，ER-011 的量測基線可直接沿用。

## 審查依據

- `apps/web/src/reader/use-reader-keyboard.ts:22-30`（不做動畫的理由）
- `apps/web/src/reader/position.ts:14-25`
- `apps/web/src/reader/member-sync.ts:1-6`
- `apps/web/src/reader/chapter-loader.ts`
- `apps/web/src/reader/SpeechControls.tsx`
- `apps/web/src/reader/reader-state.ts:12-19`
