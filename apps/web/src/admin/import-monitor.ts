import type { ImportJob, ImportQuality } from '../api/import-types.ts';
import { t } from '../i18n/translate.ts';

export interface ImportSnapshot { job: ImportJob | null; quality: ImportQuality | null; error: string | null }
export interface ImportTransport {
  job(id: string, signal: AbortSignal): Promise<ImportJob>;
  quality(id: string, signal: AbortSignal): Promise<ImportQuality>;
}
interface Watch { controller: AbortController; timer?: ReturnType<typeof setTimeout>; snapshot: ImportSnapshot }
const pending = new Set(['queued', 'processing']);
const hasQuality = new Set(['ready', 'review_required']);

/** Each ID has one sequential loop. Restarting replaces its identity even if abort is ignored. */
export function createImportMonitor(
  transport: ImportTransport,
  onUpdate: (id: string, snapshot: ImportSnapshot) => void,
  intervalMs = 1500,
) {
  const watches = new Map<string, Watch>();
  function stop(id?: string) {
    for (const [key, watch] of watches) {
      if (id !== undefined && key !== id) continue;
      watches.delete(key);
      watch.controller.abort();
      clearTimeout(watch.timer);
    }
  }
  function watch(id: string) {
    stop(id);
    const state: Watch = { controller: new AbortController(), snapshot: { job: null, quality: null, error: null } };
    watches.set(id, state);
    const current = () => watches.get(id) === state;
    async function tick() {
      let retry = false;
      try {
        if (!state.snapshot.job || pending.has(state.snapshot.job.status)) {
          const job = await transport.job(id, state.controller.signal);
          if (!current()) return;
          state.snapshot = { ...state.snapshot, job, error: null };
          onUpdate(id, state.snapshot);
        }
        const job = state.snapshot.job!;
        if (hasQuality.has(job.status) && !state.snapshot.quality) {
          const quality = await transport.quality(id, state.controller.signal);
          if (!current()) return;
          state.snapshot = { ...state.snapshot, quality, error: null };
          onUpdate(id, state.snapshot);
        }
        retry = pending.has(job.status);
      } catch (error) {
        if (!current()) return;
        state.snapshot = { ...state.snapshot, error: error instanceof Error ? error.message : t('狀態讀取失敗') };
        onUpdate(id, state.snapshot);
        // Network failures, throttling and server errors can recover. Bad credentials/IDs cannot.
        const status = (error as { status?: number } | null)?.status;
        retry = status === undefined || status === 429 || status >= 500;
      }
      if (!current()) return;
      if (retry) state.timer = setTimeout(() => { void tick(); }, intervalMs);
      else watches.delete(id);
    }
    void tick();
  }
  return { watch, stop };
}
