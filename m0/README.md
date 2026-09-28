# M0｜規格及高風險 POC

對應 `../dev-plan.md` §22 M0 與 §24 開工清單。M0 的產出是**可驗證的 POC 與測試**，不是產品代碼；通過與否決定 M1 起的工程基線。

## 執行方式

```bash
cd m0
pnpm install
pnpm fixtures   # 重新生成 fixtures/（確定性：同 seed 同輸出）
pnpm test       # 不規則章號解析（10 cases）
pnpm poc        # 繁簡轉換 + 安全清理自檢
pnpm serve      # http://localhost:8787/reader-poc/{epubjs,foliate}.html
pnpm smoke      # Playwright headless 冒煙測試（需已 serve）
```

## 內容與 gate 對應

| 項目 | 位置 | 對應規格 |
| --- | --- | --- |
| 合成 fixtures：1–180／1–190（101–104 修訂）／＋87.5／局部 181–190／局部 1–170／奇怪章號 | `fixtures/txt/` | §24、IMP-01..09 |
| 合成 EPUB 3（spine 順序 ≠ 檔名順序、nav 目錄） | `fixtures/sample.epub` | IMP-16 |
| 章號解析器：12.10≠12.1、12.5≠12.50、上下篇、番外、序/終章、中文數字、全形數字；原字串永不改寫 | `label-parser/` | §09、ADR-01 |
| epub.js 候選頁 | `reader-poc/epubjs.html` | §16 M0 gate |
| foliate-js 候選頁（同一樣本、同一功能集） | `reader-poc/foliate.html` | §16 M0 gate（v1.3 雙候選） |
| 段落定位：點擊段落保存 `spineIndex + paragraph_index`，重載/改字號/切繁簡/切分頁後回錨 | `reader-poc/poc-common.js` | §14（v1.3 定位收斂） |
| 繁簡由原文產生、永不往返轉換 | `poc/opencc-poc.mjs`、POC 頁「原文/繁/簡」 | §15 |
| allowlist 清理：script／事件／外連全除，內部錨點保留 | `poc/sanitize-poc.mjs` | §19 |

## 版本紀錄（§16：閱讀 library 選型須記錄差異）

| 套件 | 版本 | 來源與差異 |
| --- | --- | --- |
| epub.js | upstream tag `v0.3.93`（commit `0963efe9`）自建 | 本機 registry 的 npm `epub.js` 最新只有 `0.2.15`（2014），**與 upstream 差距極大**；POC 採 GitHub tag 自行 webpack build。bundle：`reader-poc/vendor/epubjs/epub.min.js`，sha256 `4ddb66f65a755531ce718927facc819b8fced7706c47ad61c73244f4ce1d0667`。JSZip 為 build 外部依賴，另附 `jszip.min.js`（jszip 3.x，取自 build 依賴樹）。M1 若採用，須重新評估固定取得方式（fork / mirror registry / vendored tarball） |
| foliate-js | commit `78914aef4466eb960965702401634c2cb348e9b1`（main shallow clone） | 不在 npm 發布；直接 vendor 原始 ESM。API 未穩定（v1.3 已註明），M0 期間鎖此 commit，升級須重跑 smoke＋真機 |
| opencc-js | npm `1.4.2`（鎖定） | 純 JS 實作；與官方 OpenCC 引擎不保證逐字一致（§15），輸出品質於 M2 匯入真實樣本時複核 |
| dompurify / jsdom | 3.4.16 / 26.1.0 | 僅 POC 清理驗證用 |

## 已驗證／未驗證（§22A 分層，如實申報）

**已驗證（L1，headless Chromium 390×844）：**兩引擎頁面載入同一 EPUB、按章導覽、段落標記、點擊保存 `paragraph_index`、重載回錨（加大字號至內容溢出後仍回同段落）、繁→簡由原文產生、切換 flow/字號無錯誤。見 `pnpm smoke`。

**未驗證（L3，必須真機）：**iOS Safari、Android Chrome。Headless 通過 ≠ 真機通過。

## 真機比較清單（擇一前必做）

兩頁在同一裝置、同一天依序操作，記錄下表。管理 URL：區網內 `http://<host>:8787/reader-poc/epubjs.html`。

| 檢核（§16 M0 gate） | epub.js | foliate-js |
| --- | --- | --- |
| 按章資源載入（換章速度、白屏） | | |
| 穩定定位：點段落→殺掉瀏覽器重開→回同段 | | |
| 繁簡切換後重排並回錨 | | |
| 分頁／捲動切換、左右翻頁手勢 | | |
| 底部控制列不被瀏覽器工具列遮擋（safe-area） | | |
| iframe 內點擊、滾動慣性、長按選字不誤翻頁 | | |
| 大字號（A＋ 數次）下的分頁邊界與空白頁 | | |
| 崩潰／白屏／console 錯誤 | | |

決策紀錄格式：`日期 / 裝置與 OS / 各項結果 / 選擇與理由`，補進 `../dev-plan.md` §23 ADR。

## 已知限制

- 章號解析的中文數字僅支援到「千」；更大數字與混合寫法（如「一萬二千」）回 `null`（接受章節、只降級匹配證據）。
- POC 的繁簡轉換在 `textContent` 層級，會抹平行內標記；正式實作須逐 text node 轉換（§15）。
- `serve.mjs` 無快取／壓縮，僅供 POC。
- epub.js build 需 JSZip 全域，正式整合時改為 bundle 一體。
