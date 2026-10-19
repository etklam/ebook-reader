import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, getWork } from '../api/client.ts';
import type { ReaderWork } from '../api/types.ts';
import { resolveMemberEntry, type MemberEntry } from './member-sync.ts';
import { loadPosition, loadSettings, normalizeSettings, parsePositionHash, saveSettings, type ReaderSettings, type ReadingPosition } from './reader-state.ts';

type Input = {
  workRef: string; initialChapterRef: string | null; initialHash: string; reloadToken: number;
  loadChapter(id: string, position: ReadingPosition | null): Promise<void>;
  onWork(work: ReaderWork): void; onMember(member: MemberEntry): void;
  onNavigate(): void;
  onSettings(settings: ReaderSettings): void; onError(error: unknown): void;
};

// Work/account initialization and route navigation have separate lifetimes:
// a chapter route change must not reload account settings or resume another book.
export function useReaderEntry(input: Input) {
  const latest = useRef(input);
  latest.current = input;
  const resolvedWork = useRef<ReaderWork | null>(null);
  const handled = useRef('');
  const [ready, setReady] = useState(false);
  const { workRef, reloadToken, initialChapterRef, initialHash, loadChapter } = input;
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void (async () => {
      try {
        const work = await getWork(workRef);
        if (cancelled) return;
        resolvedWork.current = work;
        latest.current.onWork(work);
        const member = await resolveMemberEntry(work.id);
        if (cancelled) return;
        latest.current.onMember(member);
        if (member.settings) {
          const settings = normalizeSettings({ ...loadSettings(), ...member.settings });
          saveSettings(settings); latest.current.onSettings(settings);
        }
        const route = latest.current;
        const saved = member.position ?? loadPosition(work.id);
        const target = route.initialChapterRef ?? saved?.chapterId ?? work.firstChapterId;
        if (!target) throw new ApiRequestError(404, 'chapter_not_found');
        const deep = route.initialChapterRef ? parsePositionHash(route.initialHash) : null;
        handled.current = `${route.initialChapterRef ?? ''}|${route.initialHash}`;
        setReady(true);
        if (deep || !route.initialChapterRef) {
          handled.current = `${target}|`;
          history.replaceState(history.state, '', deep ? location.pathname : `/read/${workRef}/${target}`);
          dispatchEvent(new PopStateEvent('popstate'));
        }
        await loadChapter(target, deep ? { chapterId: target, ...deep } : saved);
      } catch (error) { if (!cancelled) latest.current.onError(error); }
    })();
    return () => { cancelled = true; };
  }, [workRef, reloadToken, loadChapter]);

  useEffect(() => {
    const workId = resolvedWork.current?.id;
    if (!ready || !initialChapterRef || !workId) return;
    const key = `${initialChapterRef}|${initialHash}`;
    if (handled.current === key) return;
    const previousChapter = handled.current.split('|')[0];
    handled.current = key;
    const deep = parsePositionHash(initialHash);
    if (!deep && previousChapter === initialChapterRef) return;
    latest.current.onNavigate();
    const historyPosition = history.state?.readerPosition as ReadingPosition | undefined;
    const saved = historyPosition ?? loadPosition(workId);
    if (deep) {
      handled.current = `${initialChapterRef}|`;
      history.replaceState(history.state, '', location.pathname);
      dispatchEvent(new PopStateEvent('popstate'));
    }
    void loadChapter(initialChapterRef, deep ? { chapterId: initialChapterRef, ...deep } : saved);
  }, [ready, workRef, initialChapterRef, initialHash, loadChapter]);
}
