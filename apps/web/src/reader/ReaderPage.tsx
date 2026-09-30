// ReaderPage (M5): one canonical chapter at a time. Owns data fetching (with
// stale-response cancellation), position restore, reading mode rendering, and
// chrome toggling. Position contract: chapter_id + revision_id +
// paragraph_index; page numbers are view-local and never persisted.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError, getChapter, getWork } from '../api/client.ts';
import type { ReaderChapter, ReaderWork } from '../api/types.ts';
import { splitParagraphs } from './paragraphs.ts';
import { convertParagraphs } from './conversion.ts';
import {
  loadPosition, loadSettings, remapPosition, savePosition, saveSettings,
  type ReaderSettings, type ReadingPosition,
} from './reader-state.ts';
import {
  captureColumnParagraph, captureScrollIndex, columnCount,
  columnIndexForParagraph, fractionInParagraph, restoreScrollPosition, PARA_ATTR,
} from './position.ts';
import { clampPage, debounce } from './pagination.ts';
import { ReaderContent } from './ReaderContent.tsx';
import { ReaderToolbar } from './ReaderToolbar.tsx';
import { BottomSheet } from './BottomSheet.tsx';
import { TableOfContents } from './TableOfContents.tsx';
import { ReaderSettingsPanel } from './ReaderSettings.tsx';
import { navigate } from '../App.tsx';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; code: string; retryable: boolean };

const ERROR_TEXT: Record<string, string> = {
  work_not_found: '找不到這部作品',
  chapter_not_found: '找不到這一章',
  forbidden: '這部作品尚未公開',
  content_unavailable: '章節內容暫時無法讀取',
  network: '網路異常，請重試',
};

// small body cache: next/prev revisits and preloads never re-fetch an
// unchanged revision; a failed preload never breaks the current page
const chapterCache = new Map<string, ReaderChapter>();

async function fetchChapter(chapterId: string): Promise<ReaderChapter> {
  const hit = chapterCache.get(chapterId);
  if (hit) return hit;
  const ch = await getChapter(chapterId);
  if (chapterCache.size > 8) chapterCache.delete(chapterCache.keys().next().value!);
  chapterCache.set(chapterId, ch);
  return ch;
}

function prefetchChapter(chapterId: string | null): void {
  if (chapterId && !chapterCache.has(chapterId)) getChapter(chapterId).catch(() => undefined);
}

const COLUMN_GAP = 48;

export function ReaderPage({ workId, initialChapterId }: { workId: string; initialChapterId: string | null }) {
  const [work, setWork] = useState<ReaderWork | null>(null);
  const [chapter, setChapter] = useState<ReaderChapter | null>(null);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [settings, setSettings] = useState<ReaderSettings>(() => loadSettings());
  const [converted, setConverted] = useState<string[] | null>(null);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [sheet, setSheet] = useState<null | 'toc' | 'settings'>(null);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [vpWidth, setVpWidth] = useState(0);
  const [approxRestore, setApproxRestore] = useState(false);

  const seqRef = useRef(0);           // stale-fetch guard (§13)
  const stripRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pendingAnchor = useRef<ReadingPosition | null>(null);

  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  // --- anchor capture (mode-aware) ------------------------------------------------
  const captureAnchor = useCallback((): ReadingPosition | null => {
    if (!chapter) return null;
    const root = stripRef.current;
    const vp = viewportRef.current;
    if (!root || !vp) return null;
    if (settings.mode === 'scroll') {
      const index = captureScrollIndex(vp, root);
      const el = root.querySelector<HTMLElement>(`[${PARA_ATTR}="${index}"]`);
      return {
        chapterId: chapter.chapterId,
        revisionId: chapter.revisionId,
        paragraphIndex: index,
        fraction: el ? fractionInParagraph(vp, el) : 0,
      };
    }
    return {
      chapterId: chapter.chapterId,
      revisionId: chapter.revisionId,
      paragraphIndex: captureColumnParagraph(root, vp),
      fraction: 0,
    };
  }, [chapter, settings.mode]);

  // capture the anchor before a layout-changing setting applies (§11.3).
  // Mode round-trips (scroll→paginated→scroll) restore the exact scroll-mode
  // paragraph: column granularity would otherwise eat the intra-column offset.
  const lastScrollAnchor = useRef<ReadingPosition | null>(null);
  const changeLayout = useCallback((patch: Partial<ReaderSettings>) => {
    if (patch.mode === 'scroll' && settings.mode === 'paginated' && chapter) {
      const remembered = lastScrollAnchor.current;
      pendingAnchor.current = remembered?.chapterId === chapter.chapterId ? remembered : captureAnchor();
    } else {
      const anchor = captureAnchor();
      pendingAnchor.current = anchor;
      if (anchor && settings.mode === 'scroll') lastScrollAnchor.current = anchor;
    }
    updateSettings(patch);
  }, [captureAnchor, updateSettings, settings.mode, chapter]);

  // --- data loading ----------------------------------------------------------------
  const loadChapter = useCallback(async (chapterId: string, restore: ReadingPosition | null) => {
    const seq = ++seqRef.current;
    setState({ phase: 'loading' });
    setConverted(null);
    setPage(0);
    setPageCount(1);
    try {
      const ch = await fetchChapter(chapterId);
      if (seq !== seqRef.current) return; // stale response — ignore (§13)
      setChapter(ch);
      setState({ phase: 'ready' });
      prefetchChapter(ch.nextChapterId);
      if (restore && restore.chapterId === ch.chapterId) {
        const exact = restore.revisionId === ch.revisionId;
        pendingAnchor.current = exact ? restore : remapPosition(restore, ch.revisionId, splitParagraphs(ch.body).length);
        setApproxRestore(!exact);
      } else {
        pendingAnchor.current = { chapterId: ch.chapterId, revisionId: ch.revisionId, paragraphIndex: 0 };
        setApproxRestore(false);
      }
    } catch (e) {
      if (seq !== seqRef.current) return;
      if (e instanceof ApiRequestError) setState({ phase: 'error', code: e.code, retryable: false });
      else setState({ phase: 'error', code: 'network', retryable: true });
    }
  }, []);

  // initial load: work metadata + entry chapter (route id → saved position → first)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const w = await getWork(workId);
        if (cancelled) return;
        setWork(w);
        const saved = loadPosition(workId);
        const target = initialChapterId ?? saved?.chapterId ?? w.firstChapterId;
        if (!target) { setState({ phase: 'error', code: 'chapter_not_found', retryable: false }); return; }
        await loadChapter(target, initialChapterId ? null : saved);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiRequestError) setState({ phase: 'error', code: e.code, retryable: false });
        else setState({ phase: 'error', code: 'network', retryable: true });
      }
    })();
    return () => { cancelled = true; };
  }, [workId]);

  // keep the URL in sync with the loaded chapter (§13)
  useEffect(() => {
    if (chapter && chapter.chapterId !== initialChapterId) {
      history.replaceState(null, '', `/read/${workId}/${chapter.chapterId}`);
    }
  }, [chapter, initialChapterId, workId]);

  // --- conversion (view-time only, paragraph count invariant, §07) -----------------
  const original = useMemo(() => (chapter ? splitParagraphs(chapter.body) : []), [chapter]);
  useEffect(() => {
    let cancelled = false;
    convertParagraphs(original, settings.conversion).then((ps) => {
      if (!cancelled) setConverted(ps);
    }).catch(() => { if (!cancelled) setConverted([...original]); });
    return () => { cancelled = true; };
  }, [original, settings.conversion]);
  const paragraphs = converted ?? original;

  // --- position: save (debounced) + flush on hide ------------------------------------
  const savePositionDebounced = useRef(
    debounce((wid: string, pos: ReadingPosition | null) => { if (pos) savePosition(wid, pos); }, 400),
  ).current;

  useEffect(() => {
    if (!chapter) return;
    const vp = viewportRef.current;
    const onSave = () => savePositionDebounced(workId, captureAnchor());
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        savePositionDebounced.cancel();
        const p = captureAnchor();
        if (p) savePosition(workId, p);
      }
    };
    // scroll mode scrolls the .reader-scroll container, not the window
    vp?.addEventListener('scroll', onSave, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      vp?.removeEventListener('scroll', onSave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [chapter, settings.mode, captureAnchor, savePositionDebounced, workId]);

  // after content mounts with a pending anchor: re-anchor, then derive the page
  useEffect(() => {
    if (state.phase !== 'ready' || !chapter || converted === null) return;
    const anchor = pendingAnchor.current;
    if (!anchor || anchor.chapterId !== chapter.chapterId) return;
    pendingAnchor.current = null;
    const root = stripRef.current;
    const vp = viewportRef.current;
    if (!root || !vp) return;
    // two frames: fonts/layout settle before we measure (§11.3)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (settings.mode === 'scroll') {
        restoreScrollPosition(vp, root, anchor.paragraphIndex, anchor.fraction ?? 0);
      } else {
        // the viewport div is shared across modes: drop any scroll-mode offset
        vp.scrollTop = 0;
        const count = columnCount(stripRef.current!, vp);
        setPageCount(count);
        setPage(clampPage(columnIndexForParagraph(root, anchor.paragraphIndex, vp, 0), count));
      }
    }));
  }, [state.phase, chapter, converted, settings.mode, settings.fontSize, settings.lineHeight, settings.paragraphSpacing]);

  // viewport resize / orientation: re-anchor the visible paragraph, recompute pages
  useEffect(() => {
    if (settings.mode !== 'paginated' || state.phase !== 'ready') return;
    const vp = viewportRef.current;
    if (!vp) return;
    const ro = new ResizeObserver(() => {
      const root = stripRef.current;
      const strip = stripRef.current;
      if (!root || !strip) return;
      setVpWidth(vp.clientWidth);
      const index = captureColumnParagraph(root, vp);
      const count = columnCount(strip, vp);
      setPageCount(count);
      const step = vp.clientWidth + COLUMN_GAP;
      setPage(clampPage(columnIndexForParagraph(root, index, vp, page * step), count));
    });
    ro.observe(vp);
    return () => ro.disconnect();
  }, [settings.mode, state.phase, page]);

  // --- navigation -----------------------------------------------------------------
  const goChapter = useCallback((chapterId: string | null) => {
    if (!chapterId) return;
    setChromeVisible(false);
    setSheet(null);
    const saved = loadPosition(workId);
    void loadChapter(chapterId, saved?.chapterId === chapterId ? saved : null);
  }, [loadChapter, workId]);

  const turnPage = useCallback((dir: 1 | -1): 'moved' | 'chapter-end' | 'chapter-start' => {
    const next = page + dir;
    if (next >= pageCount) return 'chapter-end';
    if (next < 0) return 'chapter-start';
    setPage(clampPage(next, pageCount));
    return 'moved';
  }, [page, pageCount]);

  // --- tap zones (conservative, §9.2) ----------------------------------------------
  const onTap = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // never steal from text selection or interactive content (§9.2, §18)
    if (window.getSelection()?.toString()) return;
    if ((e.target as HTMLElement).closest('a, button')) return;
    if (settings.mode === 'paginated') {
      const x = e.clientX / window.innerWidth;
      if (x < 0.25) { const r = turnPage(-1); if (r !== 'moved') goChapter(r === 'chapter-start' ? chapter?.previousChapterId ?? null : null); return; }
      if (x > 0.75) { const r = turnPage(1); if (r !== 'moved') goChapter(r === 'chapter-end' ? chapter?.nextChapterId ?? null : null); return; }
    }
    setChromeVisible((v) => !v);
  }, [settings.mode, turnPage, goChapter, chapter]);

  // --- render -----------------------------------------------------------------------
  if (!chapter || state.phase === 'loading') return <div className="reader-msg" data-testid="reader-loading">載入中…</div>;
  if (state.phase === 'error') {
    return (
      <div className="reader-msg" data-testid="reader-error">
        <p>{ERROR_TEXT[state.code] ?? '發生錯誤'}</p>
        <code className="reader-err-code">{state.code}</code>
        {state.retryable && (
          <button className="reader-btn" onClick={() => void loadChapter(chapter.chapterId, null)}>重試</button>
        )}
        <button className="reader-btn" onClick={() => navigate('/')}>離開</button>
      </div>
    );
  }
  if (!work) return <div className="reader-msg" data-testid="reader-loading">載入中…</div>;

  const paginated = settings.mode === 'paginated';
  const step = (vpWidth || 360) + COLUMN_GAP;
  const stripStyle: React.CSSProperties = paginated ? {
    height: '100%',
    columnWidth: `${vpWidth || 360}px`,
    columnGap: `${COLUMN_GAP}px`,
    columnFill: 'auto',
    transform: `translateX(${-page * step}px)`,
  } : {};

  return (
    <div
      className={`reader theme-${settings.theme}`}
      data-mode={settings.mode}
      data-chrome-visible={chromeVisible || undefined}
      style={{
        '--reader-font-size': `${settings.fontSize}px`,
        '--reader-line-height': settings.lineHeight,
        '--reader-para-spacing': `${settings.paragraphSpacing}em`,
      } as React.CSSProperties}
    >
      <header className="reader-top" data-visible={chromeVisible || undefined}>
        <button className="reader-btn" aria-label="返回" onClick={() => navigate('/')}>←</button>
        <div className="reader-top-title">
          <span className="reader-chapter-label">{chapter.labelRaw}{chapter.title ? ` ${chapter.title}` : ''}</span>
          <span className="reader-work-title">{work.title}</span>
        </div>
      </header>

      {approxRestore && (
        <p className="reader-note" role="status">章節內容已更新，已回到最接近的段落。</p>
      )}

      <div
        className={paginated ? 'reader-viewport' : 'reader-scroll'}
        ref={viewportRef}
        onClick={onTap}
        data-testid="reader-viewport"
      >
        <ReaderContent paragraphs={paragraphs} stripRef={stripRef} stripStyle={stripStyle} />
      </div>

      {paginated && <p className="reader-pageinfo" aria-live="polite">{page + 1} / {pageCount}</p>}

      <ReaderToolbar
        visible={chromeVisible}
        hasPrev={chapter.previousChapterId !== null}
        hasNext={chapter.nextChapterId !== null}
        progress={`第 ${chapter.labelRaw || '—'} 章 · ${pageCount > 1 ? `${page + 1}/${pageCount} · ` : ''}${work.chapterCount} 章`}
        onPrev={() => goChapter(chapter.previousChapterId)}
        onNext={() => goChapter(chapter.nextChapterId)}
        onToc={() => setSheet('toc')}
        onSettings={() => setSheet('settings')}
      />

      <BottomSheet open={sheet === 'toc'} title={`目錄（${work.chapterCount} 章）`} onClose={() => setSheet(null)}>
        <TableOfContents
          workId={workId}
          currentChapterId={chapter.chapterId}
          onJump={(id) => goChapter(id)}
        />
      </BottomSheet>
      <BottomSheet open={sheet === 'settings'} title="閱讀設定" onClose={() => setSheet(null)}>
        <ReaderSettingsPanel settings={settings} onChange={updateSettings} onLayoutChange={changeLayout} />
      </BottomSheet>
    </div>
  );
}
