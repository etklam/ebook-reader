# Ebook／小說閱讀平台（暫稱）

管理員維護內容的中文小說閱讀網站。需求與工程基線見 [`dev-plan.md`](dev-plan.md)（規格版本 v1.3，2026-09-28）——那是唯一規格真相，實作前先讀它。

目前進度：M0（規格及高風險 POC）程式完成，待真機驗收，見 [`m0/README.md`](m0/README.md)；M1（基礎工程）完成，gate 已過（DB-01／02／03、非 Admin 403、本機可啟動、CI L1＋L2）。

## 本機啟動（M1）

```bash
pnpm install
pnpm db:up          # docker compose 起 PostgreSQL 18（首次會建低權限 roles）
pnpm db:migrate     # migration + grants（跑兩次無害）
pnpm --filter server exec node --env-file=.env scripts/create-admin.mjs <email> <password>
pnpm dev:api        # :3000，/readyz 檢查 DB
pnpm dev:worker     # worker 骨架（M2 接佇列）
pnpm dev:web        # :5173
pnpm db:verify      # DB-01/02/03 驗收腳本
```

開發順序 M0→M7 與各階段 gate 見 dev-plan §22；驗收分層見 §22A（CI 跑 L1+L2，真機僅 M0/M5/M7）。
