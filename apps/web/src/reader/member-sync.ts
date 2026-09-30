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

interface SyncState {
  version: number;
  chapterId: string | null;
  revisionId: string | null;
}

// create a debounced progress writer for a signed-in reader; returns null for
// guests so call sites skip cleanly
export function createProgressSync(
  workId: string,
  getAnchor: () => ReadingPosition | null,
  onConflict: (server: ReadingPosition) => void,
  onError: () => void,
): {
  flush(): void;
  cancel(): void;
} | null {
  const state: SyncState = { version: -1, chapterId: null, revisionId: null };

  const write = async () => {
    const anchor = getAnchor();
    if (!anchor) return;
    if (state.version < 0) {
      // initialize from the server once
      try {
        const p = await getProgress(workId);
        state.version = p.progress?.syncVersion ?? 0;
      } catch {
        return; // retry on next tick
      }
    }
    try {
      const r = await saveProgress(workId, {
        chapterId: anchor.chapterId,
        revisionId: anchor.revisionId,
        paragraphIndex: anchor.paragraphIndex,
        fraction: anchor.fraction ?? null,
        baseVersion: Math.max(0, state.version),
      });
      state.version = r.syncVersion;
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 409) {
        // a newer device won: adopt the server position deliberately (§30)
        const p = (e.body as { progress?: ServerProgressLike }).progress;
        if (p) {
          state.version = p.syncVersion;
          onConflict({
            chapterId: p.chapterId,
            revisionId: p.revisionId,
            paragraphIndex: p.paragraphIndex,
            fraction: p.fraction ?? undefined,
          });
        }
      } else {
        onError(); // transient failure: local state stays, retry next tick (§44)
      }
    }
  };

  return {
    flush: () => void write(),
    cancel: () => undefined,
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
