# Beta Runbook

**建立日期：2026-10-03｜對應 M7 Phase 4｜狀態：可照做，但 L3 真機未驗。**

本文件的標準是「**別人照著做得出來**」。每一節都是實際可執行的指令，不是說明。
規格真相是 `dev-plan.md`；進度真相是 `dev-plan.md` §26。

> **上線前的硬性前提：`docs/adr/l3-device-checklist.md` 的 18 項真機驗證尚未執行。**
> 在 iOS Safari 與 Android Chrome 實機跑完並記錄之前，不得對外稱閱讀器已驗收。
> 這是唯一無法由自動化測試替代的 gate（§22A）。

---

## 0｜一頁速查

| 要做的事 | 指令 |
| --- | --- |
| **正式部署** | [`docs/deployment.md`](deployment.md)（Forgejo Actions → g2 K3s） |
| 起資料庫 | `pnpm db:up` |
| 跑 migration＋grants | `pnpm db:migrate` |
| 驗 schema／約束 | `pnpm db:verify` |
| 建 Admin | `pnpm --filter server exec node --env-file=.env scripts/create-admin.mjs <email> <pw>` |
| 健康檢查（cron 用） | `pnpm ops:check` |
| 備份 | `pnpm backup` |
| **驗證備份**（必做） | `RESTORE_SUPERUSER_URL=… pnpm --filter server restore:verify -- --from=<dir>` |
| 回收（session／孤立檔） | `pnpm maintenance`（storage 預設 dry-run，加 `--apply` 才刪） |
| 效能量測 | `pnpm perf:seed` → `pnpm perf:measure` → `pnpm perf:seed --clean` |

---

## 1｜部署

### 1.1 元件

```
瀏覽器 → reverse proxy (TLS)
            ├── /           → 靜態檔（apps/web 的 vite build 產物）
            └── /api, /healthz, /readyz → API (:3000)
API    → PostgreSQL 18
worker → PostgreSQL 18（自己的 pool）
API/worker → private volume（正文、圖片、原始上傳檔）
```

**worker 是獨立 process，必須一起部署。** 沒有 worker，上傳會永遠停在 `queued`，
`pnpm ops:check` 會在 15 分鐘後報警。

### 1.2 必要環境變數

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | API 用的低權限帳戶（`ebook_api`） |
| `WORKER_DATABASE_URL` | ✅ | worker 用的低權限帳戶（`ebook_worker`） |
| `MIGRATOR_DATABASE_URL` | ✅ | 只在跑 migration／備份時需要（`ebook_migrator`） |
| `DB_TLS` | | `verify-full`（預設）或 `disable`。**`disable` 只容許 loopback** |
| `DB_CA_FILE` | | 自簽 CA 的路徑 |
| `STORAGE_ROOT` | ✅ | private volume 掛載點。**必須在備份範圍內** |
| `PORT` / `BIND_HOST` | | 預設 `3000` / `0.0.0.0`。proxy 同機時設 `BIND_HOST=127.0.0.1` |
| `CSRF_ALLOWED_ORIGINS` | ✅* | 若 proxy 會改寫 `Host` 就必填，否則所有 POST 會 403 |
| `TRUST_PROXY` | | 設 `true` 才會讀 `X-Forwarded-For`。**只有在每個請求都確定經過自家 proxy 時才可開**，否則是限流的一行繞過 |
| `HSTS` | | 正式站（純 HTTPS）設 `true` |
| `REGISTRATION_MODE` | | `closed`（預設）／`invite`／`open`。**Beta 用 `invite`**，見 §6 |
| `LOG_CLIENT_IP` | | 預設 `false`（IP 屬個資）。事件調查時才開 |
| `MAX_JSON_BYTES` | | 預設 256 KiB |
| `AUTH_RATE_LIMIT_*` | | 見 `server/.env.example` |

完整清單與預設值：`server/.env.example`。所有值在啟動時驗證，打錯字會**啟動失敗**
而不是靜默退回弱設定。

### 1.3 首次部署

```bash
# 1. 資料庫（正式環境請用受管 PostgreSQL 18 或自管 compose）
pnpm db:up

# 2. schema + 權限（以 ebook_migrator 執行）
pnpm db:migrate
pnpm db:verify            # DB-01..03＋約束驗收，必須全 PASS

# 3. 前端
pnpm build                # 產出 apps/web/dist，交給 proxy 當靜態檔

# 4. 起 API 與 worker
pnpm --filter server start        # 或 node --env-file=.env src/index.ts
pnpm --filter server start:worker

# 5. 確認
curl -fsS http://127.0.0.1:3000/readyz     # {"ok":true}
pnpm ops:check                              # exit 0
```

### 1.4 Reverse proxy 要點

- TLS 在 proxy 終止；開 `HSTS=true`
- `/api`、`/healthz`、`/readyz` 轉給 API，其餘給靜態檔
- SPA fallback：未命中的路徑回 `index.html`（`/read/:workId/:chapterId` 需要）
- 若 proxy 改寫 `Host`：把對外 origin 加進 `CSRF_ALLOWED_ORIGINS`
- 上傳路徑要放寬 body 上限至 50 MiB（EPUB），其餘保持小
- **流量控制在這一層。** API 內建的限流只是單 process 的濫用上限，不是 DDoS 防護（§16）

---

## 2｜日常：匯入 → 發布

**匯入不會發布。** 編輯 head 與公開 release 是分開的；讀者看到的永遠是 active release。

```
上傳 → worker 解析 → Admin 預覽 → commit（新作品）或 apply（既有作品）
     → 設定分類／標籤 → publish（顯式）
```

1. 後台上傳 TXT／EPUB（Admin only，30／50 MiB 上限）
2. 等狀態到 `ready` 或 `review_required`；`review_required` 代表有需要人工看的警告，不是錯誤
3. 新作品 → commit；既有作品 → 先看 `GET /api/admin/imports/:id/diff`，再 apply
   - `mode: incremental`：修訂章保留站方版本
   - `mode: overwrite`：為匹配章建新的不可變修訂（chapter_id 不變）
   - 必須帶 `baseEditVersion`；過期會回 409，重新比對
   - 建議帶 `Idempotency-Key`，重送不會做兩次
4. 首次發布需要至少一個分類
5. `POST /api/admin/works/:id/publish` → 驗證通過才原子切換 active release

### 2.1 發布被拒

`publish-preview` 的 `problems` 會說明原因：

| problem | 處理 |
| --- | --- |
| `title_required` / `invalid_work_type` / `serial_status_required` | 補作品資料 |
| `no_chapters` / `*_chapters_missing_revision` | 匯入沒完成或章節沒有 head 修訂 |
| `*_content_objects_missing` | 正文物件不在 storage——**從備份還原，不要重新匯入覆蓋** |
| `*_resource_objects_missing` | 圖片物件不在 storage——同上 |
| `category_required_for_first_publication` | 指派分類 |

### 2.2 回復一次匯入

```
POST /api/admin/imports/:id/revert-plan    # 先看會動到什麼
POST /api/admin/imports/:id/revert         # 帶 baseEditVersion
```

只有在作品仍停在該次 apply 產生的版本時才能直接回復。之後有別人改過 → 409
`revert_conflict`；被發布快照引用 → 409 `revert_published`。**兩種情況都不要硬繞過**，
改用新的匯入修正內容。

---

## 3｜備份與還原

### 3.1 備份（兩半必須一起）

```bash
pnpm backup                      # → server/backups/<timestamp>/
# db.dump + storage.tar.gz + manifest.json
```

資料庫存的是 storage **key**，volume 存的是 bytes。只備份資料庫＝還原出一個每章都
`content_unavailable` 的書庫。`manifest.json` 記錄兩半的 checksum 與列數，讓還原可以被
**驗證**而不是被假設。

建議：每日備份，保留 7 日＋每週一份保留 4 週，異地存放一份。

### 3.2 還原演練（**上線前必做一次，之後每月一次**）

```bash
RESTORE_SUPERUSER_URL=postgres://postgres:<pass>@127.0.0.1:5432/postgres \
  pnpm --filter server restore:verify -- --from=backups/<timestamp>
```

會在**丟棄用**的 database 與 storage 目錄裡還原，然後依序驗：

1. 檔案 checksum 對得上 manifest
2. 28 張表的列數對得上
3. schema 通得過 API 的 readiness probe
4. 每一個已發布章節的正文物件都在
5. 每一張已發布圖片都在
6. **真的用 API 讀出一章**（接到還原後的 DB 與 storage）

第 6 項是重點：1–5 全過也可能是一個應用程式讀不出來的備份。
最後會 drop scratch database（加 `--keep` 可保留）。**正式資料庫不會被動到。**

本專案已於 2026-10-03 實際執行並通過（8/8，含 191 章正文與一章端到端讀取）。

### 3.3 真的要還原到正式環境

```bash
# 1. 停 API 與 worker（避免寫入競爭）
# 2. 還原資料庫
docker exec -e PGPASSWORD=<pw> <container> pg_restore \
  -U <superuser> -d <db> --clean --if-exists --no-owner --no-privileges backups/<ts>/db.dump
# 3. 還原 storage
tar -xzf backups/<ts>/storage.tar.gz -C "$STORAGE_ROOT"
# 4. 權限（還原會丟掉 grants）
pnpm db:migrate        # 會重跑 apply-grants
# 5. 驗
pnpm db:verify && pnpm ops:check
# 6. 起 API 與 worker
```

---

## 4｜回收任務（建議 cron）

```bash
# 每日 03:00 — session 與 token 立即清，storage 先看不刪
0 3 * * *  cd /srv/ebook && pnpm maintenance >> /var/log/ebook-maintenance.log 2>&1

# 確認過輸出之後，再改成真的刪
0 3 * * *  cd /srv/ebook && pnpm maintenance --apply >> /var/log/ebook-maintenance.log 2>&1
```

- session／reset token 掃除**立即生效**（這些列不可能被引用）
- storage 孤立檔**預設 dry-run**：第一件該做的事是讀它想刪什麼
- 只刪「沒有任何 chapter_revision／source_file／resource 引用」且「超過 24 小時」的物件。
  24 小時的意義：匯入先寫檔再提交引用，太新的檔可能是正在進行的匯入
- 若報 `INTEGRITY (critical)`：**已發布內容的 bytes 不見了**，讀者現在就看不到。
  從備份還原，**不要**為了讓報告變乾淨而刪任何東西

---

## 5｜監測與告警

```bash
pnpm ops:check          # exit 0 健康 / 1 有警告 / 2 資料庫或 schema 不可達
pnpm ops:check --json   # 一行 JSON，給監測系統
```

| 探針 | 代表 | 動作 |
| --- | --- | --- |
| `GET /readyz` | 這個 API process 能否服務（含 schema 已遷移） | 失敗 → proxy 移出輪替 |
| `GET /healthz` | process 活著 | 失敗 → 重啟 |
| `pnpm ops:check` exit 1 | worker 停了／有 failed 匯入／已發布內容缺檔 | 人工查看，**不是**把站下線 |
| `pnpm ops:check` exit 2 | 資料庫不可達 | 事故 |
| `GET /api/admin/ops/status` | 同上，Admin 身分、JSON | 後台顯示 |

**worker 健康不進 `/readyz`。** 匯入 worker 停掉不影響任何人閱讀；若讓它造成 API
unready，proxy 會為一個不妨礙讀者的狀況把整站下線。

### 日誌

每個請求一行 JSON：`{t, lvl, ref, method, path, status, ms, role}`。
500 的回應 body 帶同一個 `ref`，所以使用者回報「error ref a1b2c3d4」可以精確定位一行。

**不會記錄**：query string、request/response body、cookie、以及預設不記 IP
（`LOG_CLIENT_IP=true` 才記）。資料庫錯誤只記 scrub 後的摘要——**絕不記 SQL 與參數**，
那些參數常含 user id、email 與 session hash。

---

## 6｜會員與帳號

### 6.1 註冊政策

`REGISTRATION_MODE` 預設 `closed`。**Beta 用 `invite`。**

```bash
# 發邀請碼（Admin）：raw token 只會出現這一次
curl -X POST https://<host>/api/admin/invites \
  -H 'content-type: application/json' -b "$ADMIN_COOKIE" -d '{"expiresInDays":7}'
```

**`open` is enabled for this release at the owner's direction.** Accounts can be created without proving email ownership; explain this limitation and provide an admin recovery contact. Before enabling `open` in other environments, assess abuse controls and account-recovery support. `invite` remains the safer default for a private Beta.

### 6.2 會員自助

| 功能 | 端點 |
| --- | --- |
| 改密碼（需輸入現有密碼） | `POST /api/me/password` |
| 看自己的登入裝置 | `GET /api/me/sessions` |
| 登出其他裝置 | `DELETE /api/me/sessions` |
| 登出某一台 | `DELETE /api/me/sessions/:handle` |

改密碼會**撤銷其他所有 session**（若原因是 cookie 被偷，留著就沒意義），
目前這台會拿到新的 cookie 不被登出。

### 6.3 會員忘記密碼

沒有寄信服務，所以是 Admin 代發一次性 token、**用站外管道**（你確認得了對方身分的管道）交給他：

```bash
curl -X POST https://<host>/api/admin/users/<userId>/password-reset \
  -H 'content-type: application/json' -b "$ADMIN_COOKIE" -d '{"expiresInHours":24}'
# → {"token":"…","email":"…"}   只存 sha256，token 只出現這一次
```

會員自行兌換：

```bash
curl -X POST https://<host>/api/auth/password-reset \
  -H 'content-type: application/json' \
  -d '{"token":"<token>","newPassword":"<new>"}'
```

兌換會**撤銷該帳號全部 session**，且**不會順便登入**——他要用新密碼自己登入。
重發新 token 會讓舊 token 立即失效。

---

## 7｜已知限制（對外說明時要照這個講）

| 項目 | 狀態 |
| --- | --- |
| **真機驗證** | **18 項未執行**，見 `docs/adr/l3-device-checklist.md`。不得稱閱讀器已完全驗收 |
| 限流 | 單 process，非分散式、非 DDoS 防護。流量控制屬 proxy／邊緣（§16） |
| 註冊 | 僅 `closed`／`invite`。`open` 需先有 email 驗證 |
| 密碼復原 | Admin 代發 token，無自助寄信 |
| EPUB 圖片 | 支援 JPEG／PNG／GIF／WebP。**SVG 不支援**（可帶 script 的文件格式），會警告並略過 |
| 註腳 | 文字保留並附在章末，有 `[註 n]` 對應標記。**不是互動式**：沒有彈出層、沒有回跳 |
| EPUB 其他 | 一個 XHTML 含多章錨點不拆分；list 內容不萃取 |
| 搜尋 | 書名／作者／分類／標籤的文字比對（含繁簡等價）。**沒有全文搜尋**，沒有中文斷詞 |
| 效能 | 已量測至 20,000 作品（`docs/perf/`）。**未做併發壓測** |
| taxonomy | 無合併機制、無 alias 表（v1.3 backlog），以停用取代 |
| 回復 | 受保護回復；補償計劃自動化屬 backlog |
| 離線 | 可續讀已載入內容並顯示待同步，**不承諾完整離線** |

---

## 8｜常見狀況

| 症狀 | 原因與處理 |
| --- | --- |
| 手機上所有 POST 都 403 `origin_mismatch` | proxy 改寫了 `Host`。把對外 origin 加進 `CSRF_ALLOWED_ORIGINS` 並重啟 API |
| 上傳後狀態卡在 `queued` | worker 沒跑。`pnpm ops:check` 會在 15 分鐘後報警 |
| 讀者看到 `content_unavailable` (409) | 該修訂的正文物件不在 storage。`pnpm ops:check` 會列出來；從備份還原 |
| 匯入後讀者看不到新內容 | 正常：匯入不發布。要 `POST /api/admin/works/:id/publish` |
| `409 revert_published` | 要回復的修訂已被發布快照引用。改用新匯入修正 |
| 登入回 `429 too_many_attempts` | 限流。`Retry-After` 是秒數；成功登入會清掉該帳號的計數 |
| `pnpm maintenance` 報大量缺檔但站是好的 | 多半是合成資料（`pnpm perf:seed`）或舊測試殘留。先 `pnpm perf:seed --clean`，再看 `INTEGRITY (critical)` 一節 |
| 啟動失敗並印 `config: X must be …` | 環境變數打錯。這是故意的——不會靜默退回弱設定 |
