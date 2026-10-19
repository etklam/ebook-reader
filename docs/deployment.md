# Production Deployment

Production runs on g2 (K3s) at `82.22.63.196`, in namespace `ebook-reader`, at `https://book.7182818.xyz`. Deployments are released by Forgejo Actions; do not build or import production images manually for a normal release.

## Prerequisites

- Push access to the Forgejo repository `etklam/ebook-reader`, branch `main`.
- Forgejo Actions runner labelled `hk` is online.
- Repository Actions secrets exist: `REGISTRY_TOKEN` (Forgejo package read/write) and `G2_SSH_KEY` (deploy SSH key). Secret values must not be added to this repository or printed in logs.
- g2 already has the `ebook-reader` database credentials and PostgreSQL TLS Secret provisioned. The database and app data use persistent volume claims.
- DNS A record `book.7182818.xyz → 82.22.63.196` exists. ExternalDNS is not relied on to create this record; verify it manually if the hostname changes or stops resolving.

## Release

1. Run the required project checks locally or in the CI validation workflow.
2. Commit application and deployment changes, then push to `main` on Forgejo (`origin`):

   ```bash
   git push origin main
   ```

   `.forgejo/workflows/deploy.yml` runs on `main` pushes. Documentation-only changes are ignored (`docs/**`, Markdown files, and `.github/**`).
3. The release job builds API and web images for `linux/amd64`, tags them with the full commit SHA, pushes them to the Forgejo Container Registry, and deploys those exact tags to g2.
4. The job applies the namespace, PVC and PostgreSQL manifests; waits for PostgreSQL; runs the migration Job; applies API, worker, web and Ingress resources; waits for the deployments and certificate; then checks the home page, public catalogue API, and unauthenticated protected API.
5. Treat the release as successful only when the workflow prints `Release verified: <SHA>...` and finishes successfully. The protected API smoke test is expected to return HTTP 401 when no session is supplied.

The workflow uses the static Docker CLI. As of `16bfa13`-equivalent changes
in the diary-v3 runner setup, that CLI may be paired with a buildx plugin;
this repository's Dockerfile deliberately contains no BuildKit-only syntax
(such as `RUN --mount=type=cache`), so the legacy builder remains fine. Do
not add BuildKit-only Dockerfile syntax without first installing and
verifying buildx on the runner.

## Verify independently

From a machine with access to g2:

```bash
ssh root@82.22.63.196 'kubectl -n ebook-reader get deploy,job,pod,ingress,certificate -o wide'
curl -fsS -o /dev/null -w '%{http_code}\n' https://book.7182818.xyz/
curl -fsS https://book.7182818.xyz/api/works
curl -sS -o /dev/null -w '%{http_code}\n' https://book.7182818.xyz/api/me/library
```

Expected: API, DB, web and worker deployments are ready; `ebook-migrate` completed; `ebook-reader-tls` is `READY=True`; home page and catalogue return 200; the protected library endpoint returns 401 without credentials. Also check the DNS A record resolves to `82.22.63.196`.

## Troubleshooting

- **Build says BuildKit is enabled but buildx is missing:** the static CLI lacks buildx. Remove `DOCKER_BUILDKIT=1`; do not assume `docker buildx` exists.
- **API pod CrashLoopBackOff with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode` (2026-10-16, fixed in `f4be148`):** the server runs TypeScript directly with Node's strip-only mode, which rejects constructor parameter properties (`constructor(readonly x: string)`). The web bundle (Vite) and the migrate job are unaffected, so a deploy can pass smoke while the API crashes at startup. Rule: inside `server/src`, declare fields explicitly instead of using `readonly`/`public`/`private` parameter properties; reproduce locally with `node --experimental-strip-types`.
- **PostgreSQL cannot read `/tmp/pg-tls/server.crt`:** the DB startup command must make `/tmp/pg-tls` traversable by `postgres` and transfer ownership of the copied certificate files and directory. The production manifest uses mode `0755` and `chown -R postgres:postgres`.
- **PostgreSQL reports `database "ebook" does not exist` after an interrupted first initialization:** inspect the DB pod and init logs first. For a brand-new deployment only, after confirming the PVC contains no data that must be retained, recreate the database PVC so the official image can complete initdb. Never delete a production PVC to repair an existing database.
- **Ingress exists but the hostname does not resolve:** verify/create the Cloudflare A record manually, then check the cert-manager Certificate and retry HTTPS verification.
- **Find full Forgejo job output:** inspect the run in Forgejo Actions. On the Forgejo host, logs are stored as compressed `.log.zst` files under `data/gitea/actions_log/etklam/ebook-reader/`; use `zstd -dc <log-file>` to read them. Find the log matching the run before diagnosing—container exit codes alone do not show the command error.

## Rollback

For an application-only regression, first verify the previous immutable image is still available. Then use `kubectl -n ebook-reader rollout undo deployment/ebook-api`, `ebook-worker`, or `ebook-web` for the affected workload and confirm readiness and HTTPS/API behavior. Do not roll back PostgreSQL schema changes independently: migrations must remain compatible with the immediately previous application release, and data/schema recovery requires the database backup procedure in [`beta-runbook.md`](beta-runbook.md).

## 2026-10-20 CR hardening rollout

Migration 0014 adds `works.toc_version` and bulk chapter mutation triggers; 0015 removes duplicate indexes while retaining the deferrable unique constraint and follows primary key. Apply migrations before the new API. Rollback details and local evidence are in [CR verification](tickets/codebase-review-2026-10-19/verification.md).

The trusted path is external client → Traefik → nginx → API. Before enabling `TRUST_PROXY=true`, apply `06-network-policy.yaml` and verify the CNI enforces it: only the selected kube-system Traefik pods reach web:8080, and only web pods reach API:3000. Verify the actual Traefik namespace/labels and disable `forwardedHeaders.insecure`; trust only explicitly configured upstream CIDRs if a CDN/proxy precedes Traefik. nginx takes Traefik's sanitized `X-Real-IP` and sends one validated address to the API, overwriting client XFF. Do not expose this nginx config outside that isolation. The API default remains `TRUST_PROXY=false`.

HTML uses enforce CSP and `no-cache`; `/assets/` uses immutable cache and missing assets return 404. Preserve assets across deployments if old open tabs must keep loading old chunks: cache headers cannot preserve files. HSTS is set for this HTTPS-only ingress topology. Plain HTTP deployments must remove HSTS and configure forwarded protocol for their own topology.

Run `BASE_URL=https://book.7182818.xyz pnpm ops:check-web` after rollout. The release workflow also checks HTML CSP, nosniff and no-cache. `client_max_body_size 55m` supports the current 50MiB EPUB upload limit including multipart overhead; increases to `IMPORT_MAX_EPUB_BYTES` or `IMPORT_MAX_TXT_BYTES` require a matching nginx limit increase.

Canonical TXT objects get private `.sidx` candidate filters. Existing objects backfill on first search; an optional serial backfill is `STORAGE_ROOT=/data node server/scripts/backfill-search-index.mjs` in the worker environment. Missing/corrupt filters fall back to canonical scanning. The removal command is the same with `--remove`; stop index-generating code first. Short queries and saturated filters may still scan a full work.

Exports admit one serializer per API process and at most 16MiB of canonical text plus attachments. Over-budget exports return 413 `export_too_large`; concurrent serialization returns 429 `export_busy`. This conservative budget was selected after local peak-RSS tests, including dense XML escapes and millions of paragraphs. Re-measure before raising the cap, increasing replicas or changing container memory limits.
