# CR-007｜消除登入帳號列舉的 timing side channel

- 嚴重度：中
- 優先級：P2
- 工作量：小
- 類型：AFK
- 狀態：implemented-local

## 要做的事

登入時，如果 email 不存在，程式直接回 401，完全不做 scrypt；如果 email 存在但密碼錯，則會做一次 scrypt（N=16384，約 50-100ms）。攻擊者可以量測回應時間，判斷哪些 email 已註冊。現有的統一錯誤訊息與 per-account limiter 只防止內容列舉，沒有消除時間差。

本票要令「帳號不存在」與「帳號存在但密碼錯」做等量的密碼雜湊工作，再回傳相同的錯誤。

## 驗收條件（按最終實作修訂）

- [x] 帳號不存在及錯誤密碼均只做一次 verify、使用相同 scrypt 成本，回相同 401。
- [x] dummy hash 為模組常數，畸形 stored hash 維持 fail-closed。
- [x] 100 次／路徑交替的本機真 hasher 量測及可注入 verifier 測試完成。

## 不在範圍

MFA、密碼強度政策、帳號鎖定、registration 的 email 驗證。也不把 timing 修正當成 rate limit 的替代品。

## 依賴

無，可獨立開始。與 CR-001 的 rate limit 修正互補。

## 實作提示

- 在 `server/src/auth/password.ts` 提供一個預先計算的 dummy stored hash，或由 auth route 持有常數。
- 注意 `password.normalize('NFKC')` 與 `expected.length` 會影響 scrypt 成本；dummy hash 的 key length 應與真實 hash 一致。
- 不要在 email 不存在時跳過 normalize 或長度檢查；將兩條路徑整理成同一個 verify helper 更易維持一致。

## 審查依據

- `server/src/routes/auth.ts:56-64`
- `server/src/auth/password.ts:22-40`
- `server/src/routes/auth.ts:35-52`：現有 IP／account limit

## 2026-10-19–20 實作結果

dummy hash 與統一 verify 已實作；兩條路徑各一次 verify 的測試及 100 次／路徑量測已完成。

完整證據、重跑方式、rollback 與未執行現場項目見 [實作與驗證](verification.md)。驗收條件按最終做法更新；未執行現場項目保留未勾。
