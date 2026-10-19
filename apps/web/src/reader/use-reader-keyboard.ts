import { useEffect, type RefObject } from 'react';

type Input = {
  sheet: string | null; mode: 'scroll' | 'paginated';
  viewportRef: RefObject<HTMLDivElement | null>;
  nextChapterId: string | null; previousChapterId: string | null;
  pageCount: number; chromeVisible: boolean;
  stepPage(direction: 1 | -1): void; goChapter(id: string | null): void;
  displaceAnchor(): void; setPage(page: number): void; setChromeVisible(visible: boolean): void;
};

export function useReaderKeyboard({ sheet, mode, viewportRef, nextChapterId, previousChapterId,
  pageCount, chromeVisible, stepPage, goChapter, displaceAnchor, setPage, setChromeVisible }: Input) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet) return;                       // an open sheet owns the keyboard
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as Element | null;
      if (e.key !== 'Escape' && target?.closest('input, textarea, select, button, a, [role="button"], [contenteditable]')) return;
      const vp = viewportRef.current;
      const paginated = mode === 'paginated';
      const screenful = (dir: 1 | -1, fraction = 0.9) => {
        if (paginated || !vp) { stepPage(dir); return; }
        displaceAnchor();
        // instant, like every other movement in the reader: DESIGN.md keeps
        // reader content un-animated so the anchor stays measurable, and a
        // smooth scroll is silently dropped while a long chapter is still
        // laying itself out
        vp.scrollBy({ top: dir * vp.clientHeight * fraction, behavior: 'auto' });
      };
      switch (e.key) {
        // in scroll mode there is no horizontal axis, so ←/→ address chapters
        case 'ArrowRight':
          if (paginated) stepPage(1); else goChapter(nextChapterId ?? null);
          break;
        case 'ArrowLeft':
          if (paginated) stepPage(-1); else goChapter(previousChapterId ?? null);
          break;
        // ↓/↑ nudge rather than jump. The scroll container is not focusable, so
        // without this the browser's own arrow scrolling never reaches it.
        case 'ArrowDown': if (paginated) stepPage(1); else screenful(1, 0.25); break;
        case 'ArrowUp': if (paginated) stepPage(-1); else screenful(-1, 0.25); break;
        case 'PageDown': screenful(1); break;
        case 'PageUp': screenful(-1); break;
        case ' ': screenful(e.shiftKey ? -1 : 1); break;
        case 'Home': displaceAnchor(); if (paginated) setPage(0); else vp?.scrollTo({ top: 0 }); break;
        case 'End': displaceAnchor(); if (paginated) setPage(pageCount - 1); else vp?.scrollTo({ top: vp.scrollHeight }); break;
        case 'Escape': if (!chromeVisible) return; setChromeVisible(false); break;
        default: return;
      }
      e.preventDefault();                      // only for keys we actually used
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [sheet, mode, stepPage, goChapter, nextChapterId, previousChapterId, pageCount, chromeVisible, displaceAnchor, viewportRef, setPage, setChromeVisible]);

}
