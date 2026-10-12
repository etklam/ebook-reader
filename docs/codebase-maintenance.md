# Codebase maintenance — 2026-10-12

## Import monitoring

`apps/web/src/admin/import-monitor.ts` owns the import job lifecycle shared by
single and batch import. Each job has one sequential request loop. Restarting a
job cancels its old generation; callbacks from an old request are discarded even
if the transport ignores cancellation. A ready job is cached while its quality
summary is retried independently. Authentication and missing-job errors stop
polling; transient failures retry.

`useImportMonitor.ts` connects that lifecycle to React and cancels it on unmount.
`api/import-types.ts` describes the import response fields used by the UI.
Admin actions release their busy state in `finally` when transport fails.

## Chapter identity

See [ADR-10](adr/adr-10-chapter-merge-identity.md). An absorbed chapter remains a
historical row. Current editorial queries exclude `merged_into_chapter_id` rows;
frozen releases and original revision ownership remain independent of that flag.
Migration `0010` adds the field and same-work reference constraints.

## Export

`server/src/export/formatters.ts` loads selected immutable contents once and
serializes TXT or EPUB. Missing selected chapter contents or supported referenced
image contents fail with `content_unavailable` instead of a partial book.
Historical EPUB metadata uses the selected publication time. Resource lookup is
indexed by revision and hash, avoiding a full resource scan for every chapter.

## Verification

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `cd server && node --env-file-if-exists=.env --test test/chapter-integrity.test.ts`

The chapter integration regression requires the migrated local database. Its
fixtures use a rollback transaction and temporary storage; shared data is retained.
