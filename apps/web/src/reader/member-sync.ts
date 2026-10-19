// Member server sync for the reader (§42-§44, §64): the M5 position contract
// (chapter_id + revision_id + paragraph_index) is persisted server-side for
// members; guests stay localStorage-only. Writes are debounced (8s) and
// flushed on chapter change / visibility hidden — never on every scroll.
// Failed syncs keep local state and retry; sync_version only advances when
// the server accepts.
import {
  ApiRequestError, getMe, getProgress, getReaderPreferences, markRead, saveProgress,
  saveReaderPreferences,
} from '../api/client.ts';
import type { ReaderChapter } from '../api/types.ts';
import {
  loadPosition, loadSettings, normalizeSettings, saveSettings,
  type ReaderSettings, type ReadingPosition,
} from './reader-state.ts';

export interface MemberEntry {
  isMember: boolean;
  position: ReadingPosition | null;
  serverVersion: number;
  settings: Partial<ReaderSettings> | null;
}

// guest→member merge policy (§31): server progress wins when present (the
// account is the continuation surface); a guest-only position is uploaded on
// the first save. Local state is never deleted, only superseded.
export async function resolveMemberEntry(workId: string): Promise<MemberEntry> {
  const local = loadPosition(workId);
  try {
    const { user } = await getMe();
    if (!user) return { isMember: false, position: local, serverVersion: 0, settings: null };
    const [prog, prefs] = await Promise.all([getProgress(workId), getReaderPreferences()]);
    return {
      isMember: true,
      position: prog.progress
        ? {
            chapterId: prog.progress.chapterId,
            revisionId: prog.progress.revisionId,
            paragraphIndex: prog.progress.paragraphIndex,
            fraction: prog.progress.fraction ?? undefined,
          }
        : local,
      serverVersion: prog.progress?.syncVersion ?? 0,
      settings: prefs.preferences,
    };
  } catch {
    return { isMember: false, position: local, serverVersion: 0, settings: null };
  }
}

// Serialize across reader instances as well as chapter changes. A departing
// reader may still be draining its final captured position when another mounts.
const workQueues = new Map<string, Promise<void>>();

export function createProgressSync(
  workId: string,
  getAnchor: () => ReadingPosition | null,
  onConflict: (server: ReadingPosition) => void,
  onError: () => void,
) {
  let version = -1;
  let pending: ReadingPosition | null = null;
  let running = false;
  let closed = false;
  let cancelled = false;
  let notify = true;
  let lastSaved = '';
  const signature = (p: ReadingPosition) => JSON.stringify([p.chapterId, p.revisionId, p.paragraphIndex, p.fraction ?? null]);

  const drain = async () => {
    while (pending) {
      const anchor = pending;
      pending = null;
      if (signature(anchor) === lastSaved) continue;
      try {
        if (version < 0) version = (await getProgress(workId)).progress?.syncVersion ?? 0;
        // cancel invalidates initialization too; finish deliberately drains it.
        if (cancelled) return;
        const result = await saveProgress(workId, {
          ...anchor, fraction: anchor.fraction ?? null, baseVersion: version,
        });
        version = result.syncVersion;
        lastSaved = signature(anchor);
      } catch (error) {
        // A genuine competing device wins. Never replay queued local anchors
        // over its position without the reader making another movement.
        pending = null;
        if (error instanceof ApiRequestError && error.status === 409) {
          const server = (error.body as { progress?: ServerProgressLike })?.progress;
          if (server) {
            version = server.syncVersion;
            if (notify) onConflict({ ...server, fraction: server.fraction ?? undefined });
          }
        } else if (notify) onError();
      }
    }
  };
  const start = () => {
    if (running) return;
    running = true;
    const previous = workQueues.get(workId) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(drain).finally(() => {
      running = false;
      if (workQueues.get(workId) === job) workQueues.delete(workId);
      if (pending) start();
    });
    workQueues.set(workId, job);
  };
  return {
    flush() {
      if (closed) return;
      const anchor = getAnchor();
      if (!anchor) return;
      pending = { ...anchor };
      start();
    },
    cancel() { closed = true; cancelled = true; pending = null; notify = false; /* invalidate callbacks and queued work */ },
    // Keep already captured final writes, detach UI, reject future flushes.
    finish() { closed = true; notify = false; },
  };
}

interface ServerProgressLike {
  chapterId: string;
  revisionId: string;
  paragraphIndex: number;
  fraction: number | null;
  syncVersion: number;
}

// chapter-read marking (§33): a chapter counts as read after the reader
// stays in it for 10s — prefetch never triggers this (it uses raw fetch).
export function scheduleReadMarking(chapter: ReaderChapter, isMember: boolean): () => void {
  if (!isMember) return () => undefined;
  const t = setTimeout(() => { void markRead(chapter.chapterId).catch(() => undefined); }, 10_000);
  return () => clearTimeout(t);
}

// preference two-way sync: apply server prefs when present, push local edits
export async function mergeServerPreferences(
  server: Partial<ReaderSettings> | null,
  apply: (s: ReaderSettings) => void,
): Promise<void> {
  if (server) {
    const merged = normalizeSettings({ ...loadSettings(), ...server });
    saveSettings(merged);
    apply(merged);
  }
}

export async function pushPreferences(settings: ReaderSettings, isMember: boolean): Promise<void> {
  if (!isMember) return;
  await saveReaderPreferences({
    theme: settings.theme,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    paragraphSpacing: settings.paragraphSpacing,
    conversion: settings.conversion,
    mode: settings.mode,
  }).catch(() => undefined);
}
