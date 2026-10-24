# RV-016｜藍光濾鏡與定時切換主題

- 嚴重度：不適用（功能需求）
- 優先級：P3
- 工作量：小至中
- 類型：AFK
- 狀態：implemented-local（2026-10-24）

## 要做的事

加入可調強度的暖色（藍光）濾鏡，以及按時間自動在日間／夜間主題之間切換。

## 分析

### 現狀

已有三個可繪製主題 `light` / `sepia` / `dark`，加一個 `system`（`reader-state.ts:6-10`）。`system` 透過 `useSystemDark`（`matchMedia('(prefers-color-scheme: dark)')`，`useSyncExternalStore`）即時跟隨 OS，註釋也說明了理由：手機日落轉深色時，讀者不該要重開書。主題以 `.reader.theme-light/sepia/dark` 套用（`reader.css:25/47/68`）。

沒有的是藍光濾鏡與自訂時間切換。

### 兩個實作陷阱，必須先知道

**(1) `filter: sepia()` 會毀掉語義色。** 藍光濾鏡最直覺的做法是對閱讀器容器套 `filter: sepia()`。實測（原樣／sepia／multiply 三欄並排渲染）顯示 sepia 是一個固定矩陣，會把所有色相拉向同一點：`--danger` 的紅與 `--ok` 的綠都變成相近的褐色，顏色編碼的狀態不再分得出。以暖白色做 `mix-blend-mode: multiply` 則是逐通道縮放，抽走藍光之餘紅綠仍然互相分辨得到。

> **開票時的判斷有一處錯誤，已更正。** 本票原本寫「filter 會令工具列與底部面板脫離視窗，套上去就會立刻看到」。實際渲染後並非如此 —— 非 `none` 的 `filter` 確實會令元素成為 `position: fixed` 子孫的 containing block，但 `.reader` 本身就是 `position: fixed; inset: 0`，與視窗同一個盒，所以這個改變在目前版面下完全看不出來。這條規則仍然值得知道：它正是為什麼遮罩（或濾鏡）**不能**往下搬到 `.reader-scroll` —— 那個元素不與視窗同盒。

兩條路線：
- **A（採用）**：`::after` 疊一層 `pointer-events: none` 的暖色，`mix-blend-mode: multiply`。保留色相關係，而且 multiply 是可以在測試裡精確重算的運算，所以每個「主題 × 強度」組合的對比度都能被驗證而不是被假設。
- **B**：用 `filter`。除了上述色相問題，其輸出也難以在單元測試中重現（要重做 sepia 矩陣再疊 saturate，合成順序含糊），等於放棄對比度的自動驗證。

**(2) 定時切換不能與 `system` 打架。** 現在 `system` 的語義是「跟隨 OS」。定時切換是「跟隨時鐘」。兩者同時開啟就有兩個主人。建議把定時切換做成第四種 `ThemeChoice`（例如 `schedule`），而不是一個疊加在現有選擇之上的開關 —— 主題永遠只有一個來源。

另外：主題與濾鏡強度都會經既有偏好同步寫到帳號（`member-sync.ts:151-161` 的 `pushPreferences`）。`ReaderSettings` 新增欄位時，`normalizeSettings` 的版本處理（`reader-state.ts:56` 的 `normalizeTheme` 已經為 `system` 做過一次）要一併處理舊的本機設定，不能讓舊資料變成未定義值。

### 明確做不到的

原始需求的「根據環境光線自動切換」在 web 上做不到。Ambient Light Sensor API 因為隱私（可被用於側信道攻擊）已從各瀏覽器移除或鎖在旗標後，沒有可用的替代。票內必須寫明，不要用「夜間模式」含糊帶過。按時間切換是可行的那一半。

## 驗收條件

- [x] 藍光濾鏡強度可調（關／低／中／高），設定隨既有偏好同步到帳號。
- [x] 遮罩不破壞任何 `position: fixed` 的閱讀器介面，並以並排渲染佐證（連同上述更正）。
- [x] 每個「主題 × 強度」組合的對比度都在測試中計算，全部維持 AAA（≥ 7:1）；強度遞增只會減少對比、不會增加，且最高強度不得損失超過三分之一。
- [x] 定時切換是獨立的 `ThemeChoice`（不與 `system` 疊加），入夜／天亮時刻可設定，使用裝置本地時間。
- [x] `normalizeSettings` 處理舊設定與越界值；小數時數不四捨五入而是退回預設；有測試。
- [x] 票內與程式註釋都說明環境光自動切換做不到及其原因。
- [x] `pnpm lint`、`pnpm typecheck`、`pnpm test` 通過。
- [ ] `pnpm --filter web test:browser`：未執行（需 dev server 與 API）。

## 實作結果（2026-10-24）

`ThemeChoice` 增加 `'schedule'`；`resolveTheme` 多收一個 `clock`，`isNightHour` 單獨抽出成純函式處理跨午夜的視窗（19→7），並把「起訖同一小時」定義為「從不」而非「永遠」—— 沒有人會用設定同一個時刻來要求永久深色。`useLocalHour` 在整點重算，但睡眠上限 5 分鐘：一個排了 59 分鐘的計時器在 DST、手動改鐘或筆電喚醒之後都是錯的，定期重檢令三者都自行修復而不需要分別偵測；分頁回到前景時也重讀一次，因為背景分頁的計時器會被節流。

暖色以 `.reader[data-warmth]::after` 的 multiply 遮罩實作（理由見上），四段強度，0 完全不繪製 —— 一層 `rgb(255,255,255)` 的遮罩在視覺上等於沒有，但仍然要整個閱讀器每幀多合成一層。

新增 `eye-comfort.test.ts`：把 reader.css 的 oklch 主題色依瀏覽器同一套公式轉成 sRGB，套上與合成器相同的 multiply，再算對比度。三個主題 × 四段強度全部 ≥ 7:1（AAA）；另外斷言強度遞增只會減少對比，以及最高強度不得丟失超過三分之一 —— 若將來有人調暖色表而不小心調過頭，這兩條會先紅。

後端一併跟上：migration `0016_reader_eye_comfort` 新增 `warmth`／`night_from`／`night_to` 三欄與對應 CHECK，`PUT /api/me/reader-preferences` 接受並驗證（與 CHECK 同範圍，令越界值得到 400 而不是 500 的約束違規）。`MemberEntry.settings` 的型別由 `Partial<ReaderSettings>` 改為 `ReaderPreferencesDto` —— 伺服器回來的 `warmth` 是 `number` 而非已驗證的 `Warmth`，舊型別等於宣稱伺服器資料已經可信，`normalizeSettings` 才是把關的地方。

**未完成：** 瀏覽器端 e2e 未執行；真機上實際觀感（尤其深色主題疊暖色）未驗。

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
