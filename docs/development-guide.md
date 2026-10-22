# Development guide

## Repository 與 CI/CD 政策

本專案的 CI/CD **只在 Forgejo Actions 執行**：

- 主要 repository：[git.913555.xyz/etklam/ebook-reader](https://git.913555.xyz/etklam/ebook-reader)，主要分支 `main`。
- GitHub repository：[github.com/etklam/ebook-reader](https://github.com/etklam/ebook-reader)，保留程式碼同步副本，主要分支同樣是 `main`。
- 唯一 workflow 是 [`.forgejo/workflows/deploy.yml`](../.forgejo/workflows/deploy.yml)，名稱 `ci-cd`，集中執行測試、建置、發布及正式部署。
- `.github/workflows/` 不保留任何 workflow。新增或修改 CI/CD 必須放在 `.forgejo/workflows/`，不要重新加入 GitHub Actions、GitHub 部署或 GHCR 發布流程。
- GitHub 的 push／pull request 不執行專案 CI/CD；需要 CI 驗證的分支與 pull request 必須提交到 Forgejo。GitHub 分支保護如曾要求舊的 GitHub checks，repository 管理員需移除那些 required checks；Forgejo 的 required checks 應使用 `l1`、`l2-db`、`l2-browser`。

## 本機開發

CI 使用與 production Dockerfile 相同、以 digest 固定的 Node.js `26.12.1` Bookworm image，以及 pnpm `10.32.1`。本機 Node.js 版本由根目錄 `.nvmrc` 固定，請使用相同版本及 pnpm 版本，依現有 lockfile 安裝：

```bash
nvm install
nvm use
pnpm install --frozen-lockfile
cp server/.env.example server/.env  # 首次設定；已有 .env 時不要覆寫
pnpm db:up
pnpm db:migrate
pnpm db:verify
```

分別在三個終端機啟動服務：

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

預設網站為 `http://localhost:5173`，API 為 `http://localhost:3000`。瀏覽器測試需要這三個服務及已完成 migration 的本機 PostgreSQL 18。本機資料庫與 CI service database 都不得使用正式環境 credentials。

在 WSL2 使用 nvm／自訂 pnpm PATH 時，非互動 shell 可能不會載入 `.bashrc` 裡的設定。先確認 `node --version`、`pnpm --version`；自動化命令需明確載入 nvm 和 pnpm PATH，或使用已配置的互動 shell。

## 本機驗證

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm db:verify
pnpm --filter server test:e2e
pnpm --filter web exec playwright install --with-deps chromium
pnpm --filter web test:browser
```

修改閱讀器時，可先跑指定的瀏覽器測試：

```bash
pnpm --filter web exec playwright test reader.spec.ts
```

Playwright 是自動化 L2 驗證；它不能取代 [L3 真機清單](adr/l3-device-checklist.md) 的 iOS Safari／Android Chrome 實機驗收。

## Forgejo pipeline

| Job | 驗證內容 | 依賴／執行條件 |
| --- | --- | --- |
| `l1` | TypeScript、ESLint、單元測試、web build | 程式碼 push／Forgejo pull request |
| `l2-db` | 建立 CI roles/schema、migration、grants、`db:verify`、server API E2E | 獨立 PostgreSQL 18 service |
| `l2-browser` | 建立 CI DB、migration、啟動 API／worker／Vite、Chromium 全部瀏覽器測試 | 獨立 PostgreSQL 18 service；等待 readiness 後測試 |
| `release` | 發布 SHA-tagged API／web images、K3s migration、rollout、HTTPS smoke checks | 只有 push 到 Forgejo `main`，且上述三個 jobs 全部成功 |

任一驗證失敗或取消，`release` 都不執行。Feature branch 及 pull request 只做驗證，不發布 images、不部署。Push 若只包含 `docs/**`、根目錄 `*.md` 或 `.github/**`，整個 workflow 跳過；Forgejo pull request 仍會驗證。

所有 jobs 使用現有 `hk` runner。三個驗證 jobs 各自使用乾淨的 Node.js job container，兩個 L2 jobs 各自建立 database service。CI 透過 `db:5432` 連線，不綁定 runner host 的固定 5432 port，因此不同 jobs 不會共用或互相清理資料。

Runner 必須使用 Docker backend，`[container].network` 留空，讓 Forgejo 建立每個 job 的 service network；job container 需要能以 root 安裝 apt 工具及 Playwright 系統依賴。Actions checkout 及 artifact upload 使用明確的 `code.forgejo.org` URL。這些 action 原始碼下載不會啟動 GitHub Actions，也不會把 artifacts 上傳到 GitHub。

`l2-browser` 失敗時會在 job log 印出服務日誌，並在 Forgejo 上傳 `playwright-report` artifact（HTML report、test results、API／worker／web logs）。依 [Forgejo artifact 相容性文件](https://forgejo.org/docs/latest/user/actions/advanced-features/#artifacts)，workflow 使用支援的 v3 artifact protocol，不能直接換成 GitHub 未修改的 `upload-artifact@v4`。

## 提交、同步與部署

1. 在 feature branch 修改，執行相關本機檢查，再 push 到 Forgejo、建立 Forgejo pull request。
2. 在 Forgejo Actions 查看 `ci-cd`，修正失敗後才合併到 `main`。
3. 合併後，Forgejo `main` 的 push 重新驗證；通過後才執行 `release`。
4. 需要同步 GitHub 時，推送相同 commit 到 GitHub `main`。只推送 GitHub 不會觸發部署。
5. 到 Forgejo Actions 確認 `release` 成功，並出現 `Release verified: <SHA>...`；正式部署、secrets、rollback 詳見 [Production Deployment](deployment.md)。

正式發布 jobs 共用 `ebook-reader-production` concurrency group，`cancel-in-progress: false`，避免中途取消 migration 或 rollout。部署 secrets 只在 `release` 使用：`REGISTRY_TOKEN` 用於 Forgejo Container Registry，`G2_SSH_KEY` 用於 g2；不要把它們加入 GitHub、程式碼或 log。
