# RV-016｜藍光濾鏡與定時切換主題

- 嚴重度：不適用（功能需求）
- 優先級：P3
- 工作量：小至中
- 類型：AFK
- 狀態：open

## 要做的事

加入可調強度的暖色（藍光）濾鏡，以及按時間自動在日間／夜間主題之間切換。

## 分析

### 現狀

已有三個可繪製主題 `light` / `sepia` / `dark`，加一個 `system`（`reader-state.ts:6-10`）。`system` 透過 `useSystemDark`（`matchMedia('(prefers-color-scheme: dark)')`，`useSyncExternalStore`）即時跟隨 OS，註釋也說明了理由：手機日落轉深色時，讀者不該要重開書。主題以 `.reader.theme-light/sepia/dark` 套用（`reader.css:25/47/68`）。

沒有的是藍光濾鏡與自訂時間切換。

### 兩個實作陷阱，必須先知道

**(1) CSS `filter` 會造成 containing block。** 藍光濾鏡最直接的做法是對閱讀器容器套 `filter: sepia()/hue-rotate()` 之類。但只要一個元素有非 `none` 的 `filter`，它就成為其所有 `position: fixed` 子孫的 containing block —— 閱讀器的工具列、底部面板（`BottomSheet.tsx`）等固定定位元素會從「貼著視窗」變成「貼著被濾鏡的容器」，位置整個錯。這不是理論問題，是套上去就會立刻看到的。

兩條安全路線：
- **A（建議）**：不用 `filter`，改為在最上層疊一層 `pointer-events: none` 的暖色遮罩（`position: fixed` 的全螢幕 div，`background` 為低不透明度暖色，配 `mix-blend-mode: multiply`）。不觸發 containing block，也不會把圖片的色彩管線弄亂。
- **B**：用 `filter`，但只套在正文容器上，並確認沒有任何 `position: fixed` 子孫。較脆弱：將來有人在正文裡加一個 fixed 元素就會壞，而且不會有測試抓到。

**(2) 定時切換不能與 `system` 打架。** 現在 `system` 的語義是「跟隨 OS」。定時切換是「跟隨時鐘」。兩者同時開啟就有兩個主人。建議把定時切換做成第四種 `ThemeChoice`（例如 `schedule`），而不是一個疊加在現有選擇之上的開關 —— 主題永遠只有一個來源。

另外：主題與濾鏡強度都會經既有偏好同步寫到帳號（`member-sync.ts:151-161` 的 `pushPreferences`）。`ReaderSettings` 新增欄位時，`normalizeSettings` 的版本處理（`reader-state.ts:56` 的 `normalizeTheme` 已經為 `system` 做過一次）要一併處理舊的本機設定，不能讓舊資料變成未定義值。

### 明確做不到的

原始需求的「根據環境光線自動切換」在 web 上做不到。Ambient Light Sensor API 因為隱私（可被用於側信道攻擊）已從各瀏覽器移除或鎖在旗標後，沒有可用的替代。票內必須寫明，不要用「夜間模式」含糊帶過。按時間切換是可行的那一半。

## 驗收條件

- [ ] 藍光濾鏡強度可調（含關閉），設定隨既有偏好同步到帳號。
- [ ] 濾鏡不破壞任何 `position: fixed` 的閱讀器介面（工具列、底部面板、搜尋面板），並有測試或截圖佐證。
- [ ] 濾鏡不影響文字對比度低於既有主題已驗證的比例；三個主題各自在最高強度下重新核對。
- [ ] 定時切換是單一主題來源（不與 `system` 疊加），切換時刻可設定，使用裝置本地時間。
- [ ] `normalizeSettings` 正確處理不含新欄位的舊本機設定與舊帳號偏好，不產生未定義值；有測試。
- [ ] 票內與 UI 都明確說明環境光自動切換做不到及其原因，不以「自動」含糊帶過。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm --filter web test:browser` 通過。

## 不在範圍

環境光感應（瀏覽器不提供）、系統層級的螢幕色溫控制、自訂主題配色。

## 依賴

無。

## 審查依據

- `apps/web/src/reader/reader-state.ts:6-19`、`:56-83`
- `apps/web/src/reader/use-system-dark.ts`
- `apps/web/src/styles/reader.css:24-68`
- `apps/web/src/reader/BottomSheet.tsx`、`apps/web/src/reader/ReaderToolbar.tsx`（fixed 定位的受害者）
- `apps/web/src/reader/member-sync.ts:151-161`
