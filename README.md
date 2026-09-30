# Ebook／小說閱讀平台（暫稱）

管理員維護內容的中文小說閱讀網站。需求與工程基線見 [`dev-plan.md`](dev-plan.md)（規格版本 v1.3，2026-09-28）——那是唯一規格真相，實作前先讀它。

目前進度：M0（規格及高風險 POC）程式完成，待真機驗收，見 [`m0/README.md`](m0/README.md)；M1（基礎工程）完成，gate 已過（DB-01／02／03、非 Admin 403、本機可啟動、CI L1＋L2）；**M2（首次匯入）完成**——上傳→佇列→編碼偵測（TXT）／spine 解析（EPUB）→分章→staging→Admin 預覽→commit 為草稿。M2 gate（IMP-01、05、12、14–16）以真 PG e2e 驗收：base-180 建 180 章 180 修訂、commit 冪等、失敗回滾、EPUB 按 spine 順序（非檔名順序）、zip bomb／惡意 XHTML 防護。**M3（增量與中間插章）完成**——匹配引擎＋`GET /api/admin/imports/:id/diff`＋`POST /:id/apply`（`baseEditVersion` 樂觀鎖、錨點插入、modified 保留站方、無錨點需 `confirmAppend`、ambiguous/structural 需 `resolutions`）。Gate（IMP-02、04–08、18）unit 10/10＋e2e 13/13。**M4（覆蓋與可靠套用）完成**——`mode: overwrite` 建新不可變修訂（chapter_id 不變）、`Idempotency-Key` 冪等、受保護回復（`revert-plan`/`revert`，後續修改擋回復）。Gate（IMP-03、09–13、VER-01/02）e2e 17/17（serial 執行，連跑穩定）。work_release 發布快照併入 M6。

## 本機啟動（M1+M2）

```bash
pnpm install
pnpm db:up          # docker compose 起 PostgreSQL 18（首次會建低權限 roles）
pnpm db:migrate     # migration + grants（跑兩次無害）
pnpm --filter server exec node --env-file=.env scripts/create-admin.mjs <email> <password>
pnpm dev:api        # :3000，/readyz 檢查 DB
pnpm dev:worker     # 匯入 worker（PG-backed queue，輪詢處理 import jobs）
pnpm dev:web        # :5173（M2 Admin 匯入畫面：上傳→輪詢→預覽→提交為草稿）
pnpm lint           # eslint（L1）
pnpm test           # 單元測試（L1：章號解析、分章、編碼偵測）
pnpm db:verify      # DB-01/02/03 + M2 約束驗收腳本
pnpm --filter server test:e2e   # M2 匯入 L2 驗收（需 DB 已起）
```

M2 匯入 API（全部 Admin-only）：`POST /api/admin/imports`（上傳 TXT/EPUB，限 30/50 MiB）、`GET /api/admin/imports/:id`（狀態＋編碼結果＋章數）、`GET /api/admin/imports/:id/chapters`（分頁 staged 章節）、`POST /api/admin/imports/:id/commit`（冪等首匯入提交）、`POST /api/admin/imports/:id/reanalyze`（指定編碼重解析）。

開發順序 M0→M7 與各階段 gate 見 dev-plan §22；驗收分層見 §22A（CI 跑 L1+L2，真機僅 M0/M5/M7）；實際進度以 dev-plan §26 為準。
