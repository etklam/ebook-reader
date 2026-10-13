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
  loadPosition, loadSettings, normalizeSettings, parsePositionHash, remapPosition,
  savePosition, saveSettings, type ReaderSettings, type ReadingPosition,
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
import {
  createProgressSync, pushPreferences,
  resolveMemberEntry, scheduleReadMarking, type MemberEntry,
} from './member-sync.ts';
import { createBookmark } from '../api/client.ts';
import { SkeletonChapter } from '../components/Skeleton.tsx';
import { count } from '../lib/format.ts';
import { ReportTypo } from './ReportTypo.tsx';
import { createChapterLoader } from './chapter-loader.ts';
import { FullTextSearch } from './FullTextSearch.tsx';
import { SpeechControls, useSpeechReader } from './SpeechControls.tsx';
import { useReadingTimeTracker } from '../account/reading-time.ts';

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

// codes worth a retry button: the content exists, the fetch did not land.
// work_not_found / chapter_not_found / forbidden are facts about the release
// and retrying them only repeats the same answer.
const RETRYABLE = new Set(['network', 'content_unavailable']);

function retryableError(error: unknown, code: string): boolean {
  return !(error instanceof ApiRequestError) || error.status >= 500 || error.status === 429 || RETRYABLE.has(code);
}

// what to do about it — an error code on its own tells the reader nothing
const ERROR_HINT: Record<string, string> = {
  work_not_found: '它可能尚未發布，或連結已經失效。',
  chapter_not_found: '這一章可能在最近一次發布中被移除或重編了。回書庫重新進入可取得目前的目錄。',
  forbidden: '這部作品還沒有公開的發布版本，只有管理員看得到草稿。',
  content_unavailable: '正文暫時取不到，內容本身沒有遺失。稍後重試即可。',
  network: '看起來是連線中斷。重試一次通常就好；進度已經存在這台裝置上。',
};

const COLUMN_GAP = 48;
/** px of horizontal travel before a touch gesture counts as a page turn */
const SWIPE_MIN = 44;

export function ReaderPage({ workId, initialChapterId }: { workId: string; initialChapterId: string | null }) {
  const chapterLoader = useMemo(() => createChapterLoader(getChapter), [workId]);
  const [work, setWork] = useState<ReaderWork | null>(null);
  const [chapter, setChapter] = useState<ReaderChapter | null>(null);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [settings, setSettings] = useState<ReaderSettings>(() => loadSettings());
  const [converted, setConverted] = useState<string[] | null>(null);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [sheet, setSheet] = useState<null | 'toc' | 'settings' | 'report'>(null);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [vpWidth, setVpWidth] = useState(0);
  const [approxRestore, setApproxRestore] = useState(false);
  const [member, setMember] = useState<MemberEntry | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  useReadingTimeTracker(Boolean(member?.isMember && state.phase === 'ready' && chapter));
  // bumped by 重試: re-runs the whole entry resolution, which is the only
  // recovery available when the first load failed before any chapter existed
  const [reportParagraphIndex, setReportParagraphIndex] = useState(0);
  const selectedParagraph = useRef<{ chapterId: string; index: number } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const captureRef = useRef<() => ReadingPosition | null>(() => null);

  const seqRef = useRef(0);           // stale-fetch guard (§13)
  const stripRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Anchor waiting to be applied, plus whether the reader has moved since it
  // was queued. Restoring is asynchronous (fonts, then conversion, which on a
  // 200k-character chapter takes a moment), and until now a scroll made inside
  // that window was silently undone when the restore finally landed.
  const pendingAnchor = useRef<ReadingPosition | null>(null);
  const anchorDisplaced = useRef(false);
  // true from the moment the anchor is taken off the queue until the frames
  // that apply it have run — movement in that gap counts too
  const restoreInFlight = useRef(false);
  const queueAnchor = useCallback((a: ReadingPosition | null) => {
    pendingAnchor.current = a;
    anchorDisplaced.current = false;
  }, []);
  // called from every deliberate movement; a scroll event would also fire when
  // the browser clamps scrollTop into a shorter chapter, which is not the
  // reader moving and must not cancel that chapter's restore
  const displaceAnchor = useCallback(() => {
    if (pendingAnchor.current || restoreInFlight.current) anchorDisplaced.current = true;
  }, []);
  const ruleRef = useRef<HTMLSpanElement | null>(null);

  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      void pushPreferences(next, Boolean(member?.isMember));
      return next;
    });
  }, [member?.isMember]);

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

  useEffect(() => {
    const rememberSelection = () => {
      const selection = window.getSelection();
      if (!selection?.toString().trim() || !chapter) return;
      const node = selection.anchorNode;
      const element = node instanceof Element ? node : node?.parentElement;
      const paragraph = element?.closest(`[${PARA_ATTR}]`);
      if (paragraph && stripRef.current?.contains(paragraph)) {
        selectedParagraph.current = { chapterId: chapter.chapterId, index: Number(paragraph.getAttribute(PARA_ATTR)) };
      }
    };
    document.addEventListener('selectionchange', rememberSelection);
    return () => document.removeEventListener('selectionchange', rememberSelection);
  }, [chapter]);
  function openReport() {
    const selected = selectedParagraph.current;
    const index = selected && selected.chapterId === chapter?.chapterId ? selected.index : captureAnchor()?.paragraphIndex ?? 0;
    setReportParagraphIndex(index); setSheet('report');
  }

  captureRef.current = captureAnchor;

  // capture the anchor before a layout-changing setting applies (§11.3).
  // Mode round-trips (scroll→paginated→scroll) restore the exact scroll-mode
  // paragraph: column granularity would otherwise eat the intra-column offset.
  const lastScrollAnchor = useRef<ReadingPosition | null>(null);
  const changeLayout = useCallback((patch: Partial<ReaderSettings>) => {
    if (patch.mode === 'scroll' && settings.mode === 'paginated' && chapter) {
      const remembered = lastScrollAnchor.current;
      queueAnchor(remembered?.chapterId === chapter.chapterId ? remembered : captureAnchor());
    } else {
      const anchor = captureAnchor();
      queueAnchor(anchor);
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
      const ch = await chapterLoader.load(chapterId);
      if (seq !== seqRef.current) return; // stale response — ignore (§13)
      setChapter(ch);
      setState({ phase: 'ready' });
      chapterLoader.prefetch(ch.nextChapterId);
      if (restore && restore.chapterId === ch.chapterId) {
        const exact = restore.revisionId === ch.revisionId;
        queueAnchor(exact ? restore : remapPosition(restore, ch.revisionId, splitParagraphs(ch.body).length));
        setApproxRestore(!exact);
      } else {
        queueAnchor({ chapterId: ch.chapterId, revisionId: ch.revisionId, paragraphIndex: 0 });
        setApproxRestore(false);
      }
    } catch (e) {
      if (seq !== seqRef.current) return;
      const code = e instanceof ApiRequestError ? e.code : 'network';
      setState({ phase: 'error', code, retryable: retryableError(e, code) });
    }
  }, [chapterLoader, queueAnchor]);

  // initial load: work metadata + entry chapter (route id → saved position → first)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const w = await getWork(workId);
        if (cancelled) return;
        setWork(w);
        const entry = await resolveMemberEntry(workId);
        if (cancelled) return;
        setMember(entry);
        if (entry.settings) {
          const merged = normalizeSettings({ ...loadSettings(), ...entry.settings });
          saveSettings(merged);
          setSettings(merged);
        }
        const saved = loadPosition(workId);
        const pos = entry.position ?? saved;
        const target = initialChapterId ?? pos?.chapterId ?? w.firstChapterId;
        if (!target) { setState({ phase: 'error', code: 'chapter_not_found', retryable: false }); return; }
        // a `#p=…&rev=…` deep link (a bookmark) names the paragraph explicitly
        // and outranks the resumed position; it is consumed once, so scrolling
        // away and reloading keeps the new place rather than snapping back
        const deep = initialChapterId ? parsePositionHash(location.hash) : null;
        if (deep) history.replaceState(null, '', `/read/${workId}/${initialChapterId}`);
        // restore whenever the saved position is for THIS chapter — reload and
        // back-navigation land on the same paragraph regardless of entry path;
        // loadChapter ignores restores for other chapters
        await loadChapter(target, deep ? { chapterId: target, ...deep } : pos);
      } catch (e) {
        if (cancelled) return;
        const code = e instanceof ApiRequestError ? e.code : 'network';
        setState({ phase: 'error', code, retryable: retryableError(e, code) });
      }
    })();
    return () => { cancelled = true; };
  }, [workId, reloadToken]);

  // a chapter counts as read after 10s of reading (never via prefetch, §33)
  useEffect(() => {
    if (!chapter || !member?.isMember) return;
    return scheduleReadMarking(chapter, true);
  }, [chapter, member?.isMember]);

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

  // position within the chapter, written straight to the DOM: a progress rule
  // that re-rendered on every scroll event would be a frame budget spent on
  // nothing. In paginated mode the width comes from page/pageCount in render.
  const paintRule = useCallback(() => {
    const vp = viewportRef.current;
    const rule = ruleRef.current;
    if (!vp || !rule || settings.mode !== 'scroll') return;
    const span = vp.scrollHeight - vp.clientHeight;
    const progress = span > 0 ? Math.min(100, (vp.scrollTop / span) * 100) : 0;
    rule.style.transform = `scaleX(${progress / 100})`;
  }, [settings.mode]);

  useEffect(() => {
    if (!chapter) return;
    const vp = viewportRef.current;
    const onSave = () => { savePositionDebounced(workId, captureAnchor()); syncSaver(); paintRule(); };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        savePositionDebounced.cancel();
        const p = captureAnchor();
        if (p) savePosition(workId, p);
        syncRef.current?.flush();
      }
    };
    // scroll mode scrolls the .reader-scroll container, not the window
    vp?.addEventListener('scroll', onSave, { passive: true });
    // input events, not the scroll event: these are unambiguously the reader
    vp?.addEventListener('wheel', displaceAnchor, { passive: true });
    vp?.addEventListener('touchmove', displaceAnchor, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      vp?.removeEventListener('scroll', onSave);
      vp?.removeEventListener('wheel', displaceAnchor);
      vp?.removeEventListener('touchmove', displaceAnchor);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [chapter, settings.mode, captureAnchor, savePositionDebounced, workId, paintRule, displaceAnchor]);

  // transient notices clear themselves — a toast that never leaves is a banner
  useEffect(() => {
    if (!syncNotice) return;
    const t = setTimeout(() => setSyncNotice(null), 3500);
    return () => clearTimeout(t);
  }, [syncNotice]);
  useEffect(() => {
    if (!approxRestore) return;
    const t = setTimeout(() => setApproxRestore(false), 5000);
    return () => clearTimeout(t);
  }, [approxRestore]);

  // member server sync: debounced writes + flush on hide (§42/§43)
  const syncRef = useRef<ReturnType<typeof createProgressSync>>(null);
  // 8s trailing debounce over scroll activity (§43); flush happens directly on
  // chapter change / visibility hidden
  const syncSaver = useRef(debounce(() => syncRef.current?.flush(), 8000)).current;
  // The reader is an SPA route, so leaving it does not trigger visibilitychange.
  // Flush both local and account progress before browser/app navigation.
  useEffect(() => {
    const flush = () => {
      savePositionDebounced.cancel();
      const pos = captureRef.current();
      if (pos) savePosition(workId, pos);
      syncSaver.cancel();
      syncRef.current?.flush();
    };
    window.addEventListener('popstate', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('popstate', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [workId, savePositionDebounced, syncSaver]);

  useEffect(() => {
    if (!member?.isMember) { syncRef.current = null; return; }
    const sync = createProgressSync(
      workId,
      () => captureRef.current(),
      (server) => {
        // a newer device won (§30): adopt the account position deliberately
        setSyncNotice('已同步至帳號最新閱讀位置');
        queueAnchor(server);
        setApproxRestore(true);
        if (chapter && server.chapterId !== chapter.chapterId) void loadChapter(server.chapterId, server);
      },
      () => setSyncNotice('進度同步暫時失敗，稍後自動重試'),
    );
    syncRef.current = sync;
    return () => { syncRef.current = null; };
  }, [member?.isMember, workId, chapter, loadChapter]);

  // after content mounts with a pending anchor: re-anchor, then derive the page
  useEffect(() => {
    if (state.phase !== 'ready' || !chapter || converted === null) return;
    const anchor = pendingAnchor.current;
    if (!anchor || anchor.chapterId !== chapter.chapterId) return;
    pendingAnchor.current = null;
    restoreInFlight.current = true;
    const root = stripRef.current;
    const vp = viewportRef.current;
    if (!root || !vp) { restoreInFlight.current = false; return; }
    // two frames: fonts/layout settle before we measure (§11.3). On a very long
    // chapter those frames can be hundreds of ms out, so the "did the reader
    // move" question is asked here, at the last possible moment, rather than
    // when the effect was scheduled.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      restoreInFlight.current = false;
      const displaced = anchorDisplaced.current;
      if (settings.mode === 'scroll') {
        // the reader already moved on; their place wins over the queued one
        if (!displaced) restoreScrollPosition(vp, root, anchor.paragraphIndex, anchor.fraction ?? 0);
        paintRule();
      } else {
        // the page count is a fact about the layout and is always refreshed;
        // only the jump to the anchor is skipped
        const count = columnCount(stripRef.current!, vp);
        setPageCount(count);
        if (displaced) return;
        // the viewport div is shared across modes: drop any scroll-mode offset
        vp.scrollTop = 0;
        setPage(clampPage(columnIndexForParagraph(root, anchor.paragraphIndex, vp, 0), count));
      }
    }));
  }, [state.phase, chapter, converted, settings.mode, settings.fontSize, settings.lineHeight, settings.paragraphSpacing, paintRule]);

  // viewport resize / orientation: re-anchor the visible paragraph, recompute
  // pages. The current page is read through a ref rather than a dependency:
  // with `page` in the deps the observer was torn down and re-created on every
  // page turn, and ResizeObserver delivers a callback the moment it observes —
  // so each turn immediately re-derived its own page from scratch.
  const pageRef = useRef(0);
  pageRef.current = page;
  useEffect(() => {
    if (settings.mode !== 'paginated' || state.phase !== 'ready') return;
    const vp = viewportRef.current;
    if (!vp) return;
    // the column width is known as soon as the viewport exists; publishing it
    // here rather than from the observer means the restore pass below measures
    // the layout it will actually render in
    setVpWidth(vp.clientWidth);
    let primed = false;
    const ro = new ResizeObserver(() => {
      if (!primed) { primed = true; return; }   // the delivery `observe` itself causes
      const root = stripRef.current;
      if (!root) return;
      // capture before the new width reflows the columns, re-derive after
      const index = captureColumnParagraph(root, vp);
      setVpWidth(vp.clientWidth);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const strip = stripRef.current;
        if (!strip) return;
        const count = columnCount(strip, vp);
        const step = vp.clientWidth + COLUMN_GAP;
        setPageCount(count);
        setPage(clampPage(columnIndexForParagraph(strip, index, vp, pageRef.current * step), count));
      }));
    });
    ro.observe(vp);
    return () => ro.disconnect();
  }, [settings.mode, state.phase]);

  // Page turns do not emit scroll events, so persist the new paragraph after
  // the translated strip has painted. Two frames also let an in-flight anchor
  // restore finish before this save samples the viewport.
  useEffect(() => {
    if (settings.mode !== 'paginated' || state.phase !== 'ready' || !chapter || converted === null) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (pendingAnchor.current || restoreInFlight.current) return;
        savePositionDebounced(workId, captureRef.current());
        syncSaver();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [page, settings.mode, state.phase, chapter, converted, workId, savePositionDebounced, syncSaver]);

  // --- navigation -----------------------------------------------------------------
  const goChapter = useCallback((chapterId: string | null) => {
    if (!chapterId) return;
    setChromeVisible(false);
    setSheet(null);
    const p = captureAnchor();
    if (p) savePosition(workId, p);
    syncRef.current?.flush();
    const saved = loadPosition(workId);
    void loadChapter(chapterId, saved?.chapterId === chapterId ? saved : null);
  }, [loadChapter, workId]);

  const speech = useSpeechReader({ chapterId: chapter?.chapterId ?? null,
    text: converted?.join('\n\n') ?? '', hasNextChapter: !!chapter?.nextChapterId,
    onNextChapter: () => goChapter(chapter?.nextChapterId ?? null) });

  const turnPage = useCallback((dir: 1 | -1): 'moved' | 'chapter-end' | 'chapter-start' => {
    const next = page + dir;
    if (next >= pageCount) return 'chapter-end';
    if (next < 0) return 'chapter-start';
    setPage(clampPage(next, pageCount));
    return 'moved';
  }, [page, pageCount]);

  // one step forward/back in the current mode's unit, rolling into the
  // neighbouring chapter at either edge — shared by taps, swipes and keys
  const stepPage = useCallback((dir: 1 | -1) => {
    displaceAnchor();
    const r = turnPage(dir);
    if (r === 'moved') return;
    goChapter(dir === 1 ? chapter?.nextChapterId ?? null : chapter?.previousChapterId ?? null);
  }, [turnPage, goChapter, chapter, displaceAnchor]);

  // --- tap zones (conservative, §9.2) ----------------------------------------------
  const swipeStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const swipeHandled = useRef(false);

  const onTap = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // a swipe ends in a synthetic click; it already moved the page
    if (swipeHandled.current) { swipeHandled.current = false; return; }
    // never steal from text selection or interactive content (§9.2, §18)
    if (window.getSelection()?.toString()) return;
    if ((e.target as HTMLElement).closest('a, button')) return;
    if (settings.mode === 'paginated') {
      const x = e.clientX / window.innerWidth;
      if (x < 0.25) { stepPage(-1); return; }
      if (x > 0.75) { stepPage(1); return; }
    }
    setChromeVisible((v) => !v);
  }, [settings.mode, stepPage]);

  // --- swipe to turn the page (touch, paginated only, §9.2) ------------------------
  // Mouse pointers are excluded outright so a drag-select on desktop can never
  // be read as a page turn; on touch, a long-press selection is caught by the
  // same selection guard the tap zones use.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    swipeStart.current = e.pointerType !== 'touch' || settings.mode !== 'paginated'
      ? null
      : { x: e.clientX, y: e.clientY, t: e.timeStamp };
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || window.getSelection()?.toString()) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    // horizontal, far enough, and quick enough to be a flick rather than a drag
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (e.timeStamp - start.t > 700) return;
    swipeHandled.current = true;
    window.setTimeout(() => { swipeHandled.current = false; }, 0);
    stepPage(dx < 0 ? 1 : -1);
  };

  // --- keyboard (§09.5) -------------------------------------------------------------
  // Until now the reader was pointer-only: on a desktop or with a switch/keyboard
  // the only way to advance was to open the chrome and hit a button. Arrow keys
  // move in the mode's own unit, Space/PageDown move by a screenful, Escape
  // dismisses the chrome.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet) return;                       // an open sheet owns the keyboard
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as Element | null;
      if (e.key !== 'Escape' && target?.closest('input, textarea, select, button, a, [role="button"], [contenteditable]')) return;
      const vp = viewportRef.current;
      const paginated = settings.mode === 'paginated';
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
          if (paginated) stepPage(1); else goChapter(chapter?.nextChapterId ?? null);
          break;
        case 'ArrowLeft':
          if (paginated) stepPage(-1); else goChapter(chapter?.previousChapterId ?? null);
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
  }, [sheet, settings.mode, stepPage, goChapter, chapter, pageCount, chromeVisible, displaceAnchor]);

  // --- render -----------------------------------------------------------------------
  // the error branch comes first: a failure on the very first load leaves
  // `chapter` null, and testing that first would hold the reader on the
  // loading placeholder forever with nothing to act on
  if (state.phase === 'error') {
    return (
      <div className={`reader theme-${settings.theme}`}>
        <div className="reader-msg" data-testid="reader-error">
          <h2>{ERROR_TEXT[state.code] ?? '發生錯誤'}</h2>
          <p>{ERROR_HINT[state.code] ?? '請稍後再試，或回書庫換一本。'}</p>
          <code className="reader-err-code">{state.code}</code>
          <div className="msg-actions">
            {state.retryable && (
              <button
                className="btn primary"
                onClick={() => {
                  // re-resolve from the top: work → member entry → chapter.
                  // Retrying only the chapter would strand a reader whose
                  // failure happened before any chapter was known.
                  if (chapter) void loadChapter(chapter.chapterId, loadPosition(workId));
                  else setReloadToken((n) => n + 1);
                }}
              >
                重試
              </button>
            )}
            {/* only offered when the work itself resolved: sending a reader to
                the page of a work that was not found is a second dead end */}
            {work && <button className="btn" onClick={() => navigate(`/works/${workId}`)}>回作品頁</button>}
            <button className="btn quiet" onClick={() => navigate('/')}>回書庫</button>
          </div>
        </div>
      </div>
    );
  }
  // chapter-shaped placeholder, in the reader's own theme, so the first real
  // paragraph lands where the eye is already looking
  if (!chapter || !work || state.phase === 'loading') {
    return (
      <div className={`reader theme-${settings.theme}`} data-testid="reader-loading">
        <SkeletonChapter />
      </div>
    );
  }

  const paginated = settings.mode === 'paginated';
  // one column per viewport: the strip carries no horizontal padding (see
  // reader.css), so column width + gap is exactly the distance a turn travels
  const columnWidth = vpWidth || 360;
  const step = columnWidth + COLUMN_GAP;
  const stripStyle: React.CSSProperties = paginated ? {
    height: '100%',
    columnWidth: `${columnWidth}px`,
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
      {/* running head: where you are, in the book and in the chapter. 返回 lives
          in the bottom toolbar where the thumb is (§04), not up here. */}
      <header className="reader-top" data-visible={chromeVisible || undefined}>
        <div className="reader-top-title">
          <span className="reader-chapter-label">{chapter.labelRaw}{chapter.title ? ` ${chapter.title}` : ''}</span>
          <span className="reader-work-title">{work.title}</span>
        </div>
        <span
          className="reader-rule"
          ref={ruleRef}
          style={paginated ? { transform: `scaleX(${(page + 1) / Math.max(1, pageCount)})` } : undefined}
          aria-hidden="true"
        />
      </header>

      {(approxRestore || syncNotice) && (
        <div className="reader-notes">
          {approxRestore && (
            <p className="reader-note" role="status">章節內容已更新，已回到最接近的段落。</p>
          )}
          {syncNotice && <p className="reader-note" role="status">{syncNotice}</p>}
        </div>
      )}

      <div
        className={paginated ? 'reader-viewport' : 'reader-scroll'}
        ref={viewportRef}
        onClick={onTap}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { swipeStart.current = null; }}
        data-testid="reader-viewport"
      >
        <ReaderContent paragraphs={paragraphs} resources={chapter?.resources}
          stripRef={stripRef} stripStyle={stripStyle} />
      </div>

      {/* visual only: the toolbar's readout is the single live region, so the
          page number is never announced twice when the chrome is open */}
      {paginated && <p className="reader-pageinfo" aria-hidden="true">{page + 1} / {pageCount}</p>}

      <ReaderToolbar
        visible={chromeVisible}
        hasPrev={chapter.previousChapterId !== null}
        hasNext={chapter.nextChapterId !== null}
        progress={`${chapter.labelRaw || '—'}　·　共 ${count(work.chapterCount)} 章`}
        paginated={paginated}
        page={page}
        pageCount={pageCount}
        conversion={settings.conversion}
        onPrev={() => goChapter(chapter.previousChapterId)}
        onNext={() => goChapter(chapter.nextChapterId)}
        onPrevPage={() => stepPage(-1)}
        onNextPage={() => stepPage(1)}
        onToc={() => setSheet('toc')}
        onSettings={() => setSheet('settings')}
        onBack={() => navigate(`/works/${workId}`)}
        onConversion={(conversion) => changeLayout({ conversion })}
        onBookmark={() => {
          if (!member?.isMember) { setSyncNotice('登入後可加入書籤'); return; }
          const p = captureAnchor();
          if (!p) return;
          void createBookmark({ workId, chapterId: p.chapterId, revisionId: p.revisionId, paragraphIndex: p.paragraphIndex })
            .then(() => setSyncNotice('已加入書籤'))
            .catch(() => setSyncNotice('書籤加入失敗'));
        }}
      />

      <BottomSheet open={sheet === 'toc'} title={`目錄（${count(work.chapterCount)} 章）`} onClose={() => setSheet(null)}>
        <FullTextSearch workId={workId} />
        <TableOfContents
          workId={workId}
          currentChapterId={chapter.chapterId}
          onJump={(id) => goChapter(id)}
        />
      </BottomSheet>
      <BottomSheet open={sheet === 'report'} title="回報章節錯字" onClose={() => setSheet(null)}>
        <ReportTypo key={`${chapter.chapterId}:${reportParagraphIndex}`} chapter={chapter} paragraphIndex={reportParagraphIndex} isMember={Boolean(member?.isMember)} />
      </BottomSheet>
      <BottomSheet open={sheet === 'settings'} title="閱讀設定" onClose={() => setSheet(null)}>
        <button className="btn" onClick={openReport}>回報錯字</button>
        <SpeechControls controller={speech} />
        <ReaderSettingsPanel settings={settings} onChange={updateSettings} onLayoutChange={changeLayout} />
      </BottomSheet>
    </div>
  );
}
