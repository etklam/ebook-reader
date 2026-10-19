# CR-011｜為大型作品匯出加入記憶體上限或串流

- 嚴重度：中
- 優先級：P3
- 工作量：中
- 類型：AFK（方案 A 已選定）
- 狀態：implemented-local

## 要做的事

匯出流程會把全書章節正文與所有引用圖片載入記憶體，再交由 formatter serialize 成單一 Buffer 回傳：

- `loadExportBook()` 逐章 `storage.get()`，把 body 與圖片 bytes 放進同一個 `ExportBook`；
- `search-export.ts` 最後 `Buffer.from(bytes)` 回傳完整檔案。

API container 的 memory limit 是 768Mi。匯入上限預設 50MiB EPUB，解壓後資源上限更高；大型作品的 TXT／EPUB 匯出有機會在 serialize 或回應階段 OOM，而不是回傳可理解的錯誤。

## 方案決策（已完成）

- 方案 A（採用）：為匯出設正文及附件合計 16MiB 上限，超過即回 413／409 並在 admin UI 顯示原因。
- 方案 B：改用串流 ZIP／EPUB 寫入 response，降低峰值記憶體，但 formatter 與錯誤處理要重做。
- 方案 C：非同步匯出工作（背景產生、下載連結），複雜度最高。

建議先量測一本接近上限的作品，再選 A 或 B；不要未量測就直接改成背景工作。

## 驗收條件（按最終實作修訂）

- [x] 方案 A 已選定並量測：16MiB 正文／附件上限，local storage preflight 在內容讀取前拒絕超限。
- [x] 單一 serializer、413/export_too_large 與 429/export_busy、後台文案及錯誤後釋放已完成。
- [x] XML escape／paragraph 組裝分段，正常內容與 Unicode／大量段落輸出完整性測試通過。
- [x] 最大允許輸入的 prose、XML-escape、數百萬短段落 RSS／時間／輸出大小已記錄，近上限／超限／缺檔回歸通過。
- [ ] Production node/container 與大型真實作品需在提高上限前再量測。

## 不在範圍

匯出格式新增、壓縮率最佳化、CDN 下載、匯出排程。也不把 admin-only 的匯出當成公開 API 的 DoS 面。

## 依賴

無。需要 production container 的 memory limit 與實際大型作品樣本。

## 審查依據

- `server/src/routes/search-export.ts:205-217`
- `server/src/export/formatters.ts:31-63`
- `ops/k8s/production/03-api-worker.yaml`：API memory limit 768Mi
- `server/src/config.ts:112-115`：匯入大小上限

## 2026-10-19–20 實作結果

依使用者授權選方案 A，16MiB 正文＋附件 preflight、單一 serialize、413／429 文案；另分段 XML escape／paragraph 組裝。32MiB 壓測曾 OOM，16MiB 最壞已測樣本 RSS 約 533MiB。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
