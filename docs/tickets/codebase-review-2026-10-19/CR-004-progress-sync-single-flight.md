# CR-004｜序列化會員進度同步寫入

- 嚴重度：高
- 優先級：P1
- 工作量：小至中
- 類型：AFK
- 狀態：implemented-local

## 要做的事

`createProgressSync()` 的 `flush()` 直接執行 `void write()`，沒有 in-flight 保護。debounce（8 秒）、轉章、`visibilitychange` 可以幾乎同時觸發多個寫入；每個寫入都讀同一個 `state.version` 作為 `baseVersion`，於是第二個請求會被伺服器以 409 拒絕，前端再把 server 位置當成衝突套用，可能令讀者跳回較舊位置。

ER-009 已記錄這個風險，但該票卡在「伺服器優先」與「由讀者選擇」的產品決策。本票只做不改變政策的機械修正：同一時間只有一個寫入、較新的本機 anchor 合併到下一次、過期回應不得覆蓋新狀態。

## 驗收條件（按最終實作修訂）

- [x] 同 work 跨 reader 實例初始化及寫入序列化；pending 合併為最新 anchor，成功 anchor 去重。
- [x] 換章保持同步器；cancel 失效 UI 與 pending，finish 排空已擷取的最後進度。
- [x] 可控 API 測試涵蓋並行 flush、初始化取消、在途取消、離開／重入、真正 409 與網路失敗重試。
- [x] 保持現有 server-wins 政策，不等待 ER-009 的選擇 UI 決策。

## 不在範圍

衝突提示 UI、由讀者選擇保留哪個位置、跨裝置合併政策、`resolveMemberEntry()` 在網路失敗時是否應降級為 guest。這些留在 ER-009 或另開票處理，本票不改變使用者可見的衝突政策。

## 依賴

- 機械部分無硬性依賴，可先做。
- 若會改動 409 後的行為，需先完成 ER-009 的政策決策。
- 建議在 CR-010 分拆 ReaderPage 之前完成。

## 實作提示

- 最簡單的 single-flight：

```ts
let inFlight = false;
let pending = false;

const write = async () => {
  if (inFlight) {
    pending = true;
    return;
  }
  inFlight = true;
  try {
    // 現有 write 邏輯
  } finally {
    inFlight = false;
    if (pending) {
      pending = false;
      void write();
    }
  }
};
```

- 另外比對「上次成功送出的 anchor」，完全相同就跳過，減少無效寫入。
- `cancel()` 目前是 no-op；至少要用 generation token 令舊 async 流程失效。
- 不要用 debounce 掩蓋 race；debounce 只減少頻率，不能保證順序。

## 審查依據

- `apps/web/src/reader/member-sync.ts:85-113`：`write()` 與 `flush()`
- `apps/web/src/reader/ReaderPage.tsx:362,396,405,531`：debounce、轉章與 visibility flush
- `docs/tickets/reader-improvements/ER-009-progress-sync.md`：已記錄的並行／過期回呼風險

## 2026-10-19–20 實作結果

跨同一 work 的 reader 實例共用序列化佇列，換章不重建同步器；cancel 與離開時 drain 的 finish 分開，避免刪掉最後進度。可控延遲測試已通過。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
