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
  loadSettings, remapPosition,
  resolveTheme, savePosition, saveSettings, WARMTH_FILTERS,
  type ReaderSettings, type ReadingPosition,
} from './reader-state.ts';
import { useSystemDark } from './use-system-dark.ts';
import { useLocalHour } from './use-local-hour.ts';
import {
  captureColumnParagraph, captureScrollIndex, columnCount,
  columnIndexForParagraph, fractionInParagraph, restoreScrollPosition, PARA_ATTR,
} from './position.ts';
import { clampPage, debounce, tapZone } from './pagination.ts';
import { ReaderContent } from './ReaderContent.tsx';
import { ReaderToolbar } from './ReaderToolbar.tsx';
import { BottomSheet } from './BottomSheet.tsx';
import { TableOfContents } from './TableOfContents.tsx';
import { ReaderSettingsPanel } from './ReaderSettings.tsx';
import { navigate } from '../App.tsx';
import { readPath, samePath, workPath } from '../lib/slug.ts';
import { absoluteUrl, applyHead, describe } from '../lib/head.ts';
import {
  createProgressSync, pushPreferences,
  scheduleReadMarking, type MemberEntry,
} from './member-sync.ts';
import { createBookmark } from '../api/client.ts';
import { SkeletonChapter } from '../components/Skeleton.tsx';
import { Icon } from '../components/Icon.tsx';
import { count } from '../lib/format.ts';
import { ReportTypo } from './ReportTypo.tsx';
import { createChapterLoader, shouldPrefetchNext } from './chapter-loader.ts';
import { FullTextSearch } from './FullTextSearch.tsx';
import { SpeechControls, useSpeechReader } from './SpeechControls.tsx';
import { useReadingTimeTracker } from '../account/reading-time.ts';
import { useReaderKeyboard } from './use-reader-keyboard.ts';
import { useReaderEntry } from './use-reader-entry.ts';
import { useMemberProgress } from './use-member-progress.ts';
import { BookmarkNoteEditor } from '../account/BookmarkNoteEditor.tsx';
import { currentLocale, t } from '../i18n/translate.ts';
import { useLocale } from '../i18n/I18nRoot.tsx';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; code: string; retryable: boolean };

// Source-language tables, translated at the render site below: a constant is
// evaluated at import and would not follow a language switch.
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

/** Opening prose for the chapter's meta description. Canonical bodies are
 *  paragraphs joined by \n\n, so the first couple of them are the natural
 *  summary — far better than repeating the site blurb on every chapter. */
function firstLines(body: string): string {
  return body.split('\n\n').slice(0, 2).join('　');
}

const COLUMN_GAP = 48;
/** px of horizontal travel before a touch gesture counts as a page turn */
const SWIPE_MIN = 44;

/**
 * `workRef`/`initialChapterRef` are the URL's own segments — `<slug>-<publicId>`
 * or a legacy uuid. They address content; they are NOT identity. Everything
 * that persists — the localStorage position key, account progress sync,
 * bookmarks — stays keyed by the work's uuid (`workId` below), because those
 * keys were written against uuids and the position contract outlives any URL
 * scheme (ADR-07, §14).
 */
export function ReaderPage({ workRef, initialChapterRef, initialHash = '' }: { workRef: string; initialChapterRef: string | null; initialHash?: string }) {
  // The App key equates legacy UUID and public-id aliases. Keep request
  // dependencies stable when the URL is canonicalized within the same work.
  const workAddress = useRef(workRef).current;
  const [work, setWork] = useState<ReaderWork | null>(null);
  const releaseRef = useRef<string | null>(null);
  // `work` is passed on every chapter fetch so a chapter public id — unique per
  // work, not globally — can be resolved. A uuid id ignores it.
  const chapterLoader = useMemo(() => createChapterLoader((id) => getChapter(id, workAddress), Date.now, async () => {
    // Validate visibility and current publication before consuming a body
    // fetched earlier. Metadata is small; a changed release fetches fresh text.
    const latest = await getWork(workAddress);
    const valid = latest.releaseId === releaseRef.current;
    releaseRef.current = latest.releaseId;
    setWork(latest);
    return valid;
  }), [workAddress]);
  const [chapter, setChapter] = useState<ReaderChapter | null>(null);
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const { locale } = useLocale();
  const [settings, setSettings] = useState<ReaderSettings>(() => loadSettings());
  // 'system' follows the OS and 'schedule' follows the clock, both live; the
  // other three are literal
  const theme = resolveTheme(settings.theme, useSystemDark(), {
    hour: useLocalHour(), nightFrom: settings.nightFrom, nightTo: settings.nightTo,
  });
  const warmth = WARMTH_FILTERS[settings.warmth];
  const [converted, setConverted] = useState<string[] | null>(null);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [sheet, setSheet] = useState<null | 'toc' | 'settings' | 'report' | 'bookmark'>(null);
  const [bookmarkId, setBookmarkId] = useState<string | null>(null);
  const [bookmarkSaving, setBookmarkSaving] = useState(false);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);
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

  // The uuid behind the URL's ref: null until the work metadata lands. Every
  // persisted key hangs off this, never off the ref.
  const workId = work?.id ?? null;

  const requestedChapter = useRef<{ chapterId: string; restore: ReadingPosition | null } | null>(null);
  const seqRef = useRef(0);           // stale-fetch guard (§13)
  const stripRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // The element that bounds one page and clips the strip: the viewport
  // itself on a phone, a centred measure-width box on desktop.
  const pageBoxRef = useRef<HTMLDivElement | null>(null);
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
  const prefetchedFor = useRef<string | null>(null);
  useEffect(() => () => chapterLoader.clear(), [chapterLoader]);

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
      paragraphIndex: captureColumnParagraph(root, pageBoxRef.current ?? vp),
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
  }, [captureAnchor, updateSettings, settings.mode, chapter, queueAnchor]);

  // --- data loading ----------------------------------------------------------------
  // `ref` addresses the chapter: a uuid for every in-app navigation, or the
  // URL's `<slug>-<publicId>` segment on a first load.
  const loadChapter = useCallback(async (ref: string, restore: ReadingPosition | null) => {
    requestedChapter.current = { chapterId: ref, restore };
    const seq = ++seqRef.current;
    setState({ phase: 'loading' });
    setConverted(null);
    setPage(0);
    setPageCount(1);
    try {
      const ch = await chapterLoader.load(ref);
      if (seq !== seqRef.current) return; // stale response — ignore (§13)
      setChapter(ch);
      setState({ phase: 'ready' });
      // A restore belongs to this chapter when it names the same uuid — or the
      // ref we just resolved, because a bookmark deep link is addressed by the
      // URL segment and its uuid is not known until the body lands. Normalize
      // to the uuid: every later comparison, and the saved position itself, is
      // keyed by chapter_id (§14).
      if (restore && (restore.chapterId === ch.chapterId || restore.chapterId === ref)) {
        const mine = { ...restore, chapterId: ch.chapterId };
        const exact = mine.revisionId === ch.revisionId;
        queueAnchor(exact ? mine : remapPosition(mine, ch.revisionId, splitParagraphs(ch.body).length));
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

  useReaderEntry({ workRef: workAddress, initialChapterRef, initialHash, reloadToken, loadChapter,
    onWork: (w) => { setWork(w); releaseRef.current = w.releaseId; },
    onMember: setMember,
    onNavigate: () => { setSheet(null); setChromeVisible(false); },
    onSettings: setSettings,
    onError: (e) => {
      const code = e instanceof ApiRequestError ? e.code : 'network';
      setState({ phase: 'error', code, retryable: retryableError(e, code) });
    },
  });

  // a chapter counts as read after 10s of reading (never via prefetch, §33)
  useEffect(() => {
    if (!chapter || !member?.isMember) return;
    return scheduleReadMarking(chapter, true);
  }, [chapter, member?.isMember]);

  // Keep the URL in sync with the loaded chapter (§13), and make it the
  // canonical slug path: a page turn, a stale slug after a title edit and a
  // legacy uuid link all converge on one address for one chapter — which is
  // what `<link rel="canonical">` then declares.
  useEffect(() => {
    if (!work || !chapter) return;
    const canonical = readPath(work, { id: chapter.chapterId, publicId: chapter.publicId,
      labelRaw: chapter.labelRaw, title: chapter.title });
    if (!samePath(location.pathname, canonical)) history.replaceState(history.state, '', encodeURI(canonical));
    const label = [chapter.labelRaw, chapter.title].filter(Boolean).join(' ');
    const indexable = work.visibility === 'public';
    applyHead({
      page: `${label} - ${work.title}`,
      description: describe(`${work.title}${work.author ? `（${work.author}）` : ''}${label}`,
        firstLines(chapter.body)),
      canonicalPath: canonical,
      ogType: 'article',
      // a draft is Admin-only and unlisted is readable-but-never-listed;
      // neither belongs in an index
      noindex: !indexable,
      // the chapter is a part of the book, so the graph says so: isPartOf
      // points a crawler at the work page rather than leaving 500 sibling
      // chapters looking like 500 unrelated articles
      jsonLd: indexable ? {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: label || work.title,
        url: absoluteUrl(canonical),
        inLanguage: currentLocale(),
        ...(work.author ? { author: { '@type': 'Person', name: work.author } } : {}),
        isPartOf: { '@type': 'Book', name: work.title, url: absoluteUrl(workPath(work)) },
      } : undefined,
    });
    // `locale` is a real dependency: title() and og:locale both follow the UI
    // language, and neither is visible to exhaustive-deps from in here.
  }, [work, chapter, locale]);

  // An unreadable chapter must not keep the previous chapter's head: the
  // error states below are real pages a crawler can land on.
  useEffect(() => {
    if (state.phase !== 'error') return;
    applyHead({ page: t(ERROR_TEXT[state.code] ?? '載入失敗'), noindex: true });
  }, [state, locale]);

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

  const maybePrefetchNext = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !chapter || !converted || state.phase !== 'ready' || work?.visibility === 'draft') return;
    if (pendingAnchor.current || restoreInFlight.current) return;
    const key = `${chapter.chapterId}:${chapter.revisionId}`;
    if (prefetchedFor.current === key || !shouldPrefetchNext(settings.mode, {
      scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight, viewportHeight: vp.clientHeight, page,
      pageCount: settings.mode === 'paginated' && stripRef.current ? columnCount(stripRef.current) : pageCount,
    })) return;
    prefetchedFor.current = key;
    chapterLoader.prefetch(chapter.nextChapterId);
  }, [chapter, converted, state.phase, work?.visibility, settings.mode, page, pageCount, chapterLoader]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => maybePrefetchNext());
    return () => cancelAnimationFrame(frame);
  }, [maybePrefetchNext]);

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

  // member server sync: debounced writes + flush on hide (§42/§43)
  const syncRef = useRef<ReturnType<typeof createProgressSync>>(null);
  // 8s trailing debounce over scroll activity (§43); flush happens directly on
  // chapter change / visibility hidden
  const syncSaver = useRef(debounce(() => syncRef.current?.flush(), 8000)).current;

  useEffect(() => {
    if (!chapter) return;
    const vp = viewportRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Coalesce high-frequency scroll events before reading paragraph geometry;
    // explicit navigation/hide paths still capture the current anchor at once.
    const onSave = () => {
      paintRule();
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (workId) savePositionDebounced(workId, captureAnchor());
        syncSaver();
        maybePrefetchNext();
      }, 80);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        chapterLoader.clear();
        prefetchedFor.current = null;
        savePositionDebounced.cancel();
        const p = captureAnchor();
        if (p && workId) savePosition(workId, p);
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
      if (timer !== null) clearTimeout(timer);
      vp?.removeEventListener('scroll', onSave);
      vp?.removeEventListener('wheel', displaceAnchor);
      vp?.removeEventListener('touchmove', displaceAnchor);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [chapter, settings.mode, captureAnchor, savePositionDebounced, workId, paintRule, displaceAnchor, maybePrefetchNext, chapterLoader, syncSaver]);

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

  // The reader is an SPA route, so leaving it does not trigger visibilitychange.
  // Flush both local and account progress before browser/app navigation.
  useEffect(() => {
    const flush = () => {
      savePositionDebounced.cancel();
      const pos = captureRef.current();
      if (pos && workId) savePosition(workId, pos);
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

  useMemberProgress({ workId, isMember: Boolean(member?.isMember && workId), syncRef, captureRef,
    onConflict: (server) => {
      setSyncNotice(t('已同步至帳號最新閱讀位置'));
      queueAnchor(server);
      setApproxRestore(true);
      if (server.chapterId !== chapter?.chapterId) navigate(`/read/${workId}/${server.chapterId}#p=${server.paragraphIndex}&rev=${server.revisionId}`);
    },
    onError: () => setSyncNotice(t('進度同步暫時失敗，稍後自動重試')),
  });

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
        maybePrefetchNext();
      } else {
        // the page count is a fact about the layout and is always refreshed;
        // only the jump to the anchor is skipped
        const count = columnCount(stripRef.current!);
        setPageCount(count);
        if (displaced) return;
        // the viewport div is shared across modes: drop any scroll-mode offset
        vp.scrollTop = 0;
        setPage(clampPage(columnIndexForParagraph(root, anchor.paragraphIndex), count));
      }
    }));
  }, [state.phase, chapter, converted, settings.mode, settings.fontSize, settings.lineHeight, settings.paragraphSpacing, paintRule, maybePrefetchNext]);

  // viewport resize / orientation: re-anchor the visible paragraph, recompute
  // pages. The current page is read through a ref rather than a dependency:
  // with `page` in the deps the observer was torn down and re-created on every
  // page turn, and ResizeObserver delivers a callback the moment it observes —
  // so each turn immediately re-derived its own page from scratch.
  const pageRef = useRef(0);
  pageRef.current = page;
  useEffect(() => {
    if (settings.mode !== 'paginated' || state.phase !== 'ready') return;
    // The page box, not the viewport: on desktop it is clamped to the prose
    // measure, so the viewport's width is not the column's width.
    const box = pageBoxRef.current;
    if (!box) return;
    // the column width is known as soon as the box exists; publishing it
    // here rather than from the observer means the restore pass below measures
    // the layout it will actually render in
    setPageWidth(box.clientWidth);
    let primed = false;
    const ro = new ResizeObserver(() => {
      if (!primed) { primed = true; return; }   // the delivery `observe` itself causes
      const root = stripRef.current;
      if (!root) return;
      // capture before the new width reflows the columns, re-derive after
      const index = captureColumnParagraph(root, box);
      setPageWidth(box.clientWidth);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const strip = stripRef.current;
        if (!strip) return;
        const count = columnCount(strip);
        setPageCount(count);
        setPage(clampPage(columnIndexForParagraph(strip, index), count));
      }));
    });
    ro.observe(box);
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
        if (workId) savePositionDebounced(workId, captureRef.current());
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
    const p = captureRef.current();
    if (p && workId) {
      savePosition(workId, p);
      history.replaceState({ ...history.state, readerPosition: p }, '');
    }
    syncSaver.cancel();
    syncRef.current?.flush();
    if (work) navigate(readPath(work, { id: chapterId }));
  }, [workId, work, syncSaver]);

  const speakingElement = useRef<HTMLElement | null>(null);
  const highlightSpeech = useCallback((index: number | null) => {
    speakingElement.current?.removeAttribute('data-speaking');
    const element = index === null ? null : stripRef.current?.querySelector<HTMLElement>(`[${PARA_ATTR}="${index}"]`) ?? null;
    element?.setAttribute('data-speaking', 'true');
    speakingElement.current = element;
  }, []);
  const speech = useSpeechReader({ chapterId: chapter?.chapterId ?? null,
    text: converted?.join('\n\n') ?? '', hasNextChapter: !!chapter?.nextChapterId,
    contentVersion: `${chapter?.revisionId ?? ''}:${settings.conversion}`,
    getParagraphIndex: () => captureRef.current()?.paragraphIndex ?? 0,
    onParagraph: highlightSpeech,
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
  // The bands run across the page, not down its sides: the thumb holding a
  // phone rests at the bottom, so the common action — forward — gets the
  // nearest band, and the top band mirrors it for going back. The page still
  // *travels* sideways (one column pitch per turn); only the zones are vertical.
  const swipeStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const swipeHandled = useRef(false);

  const onTap = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // a swipe ends in a synthetic click; it already moved the page
    if (swipeHandled.current) { swipeHandled.current = false; return; }
    // never steal from text selection or interactive content (§9.2, §18)
    if (window.getSelection()?.toString()) return;
    if ((e.target as HTMLElement).closest('a, button')) return;
    if (settings.mode === 'paginated') {
      // the viewport's own box, not the window: with the chrome open the bands
      // still belong to the page the reader can see
      const box = e.currentTarget.getBoundingClientRect();
      const zone = tapZone(e.clientY - box.top, box.height);
      if (zone === 'next') { stepPage(1); return; }
      if (zone === 'prev') { stepPage(-1); return; }
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

  useReaderKeyboard({ sheet, mode: settings.mode, viewportRef,
    nextChapterId: chapter?.nextChapterId ?? null, previousChapterId: chapter?.previousChapterId ?? null,
    pageCount, chromeVisible, stepPage, goChapter, displaceAnchor, setPage, setChromeVisible });

  // --- render -----------------------------------------------------------------------
  // the error branch comes first: a failure on the very first load leaves
  // `chapter` null, and testing that first would hold the reader on the
  // loading placeholder forever with nothing to act on
  if (state.phase === 'error') {
    return (
      <div className={`reader theme-${theme}`} data-warmth={warmth ? settings.warmth : undefined}
        style={{ '--reader-warmth': warmth ?? undefined } as React.CSSProperties}>
        <div className="reader-msg" data-testid="reader-error">
          <h2>{t(ERROR_TEXT[state.code] ?? '發生錯誤')}</h2>
          <p>{t(ERROR_HINT[state.code] ?? '請稍後再試，或回書庫換一本。')}</p>
          <code className="reader-err-code">{state.code}</code>
          <div className="msg-actions">
            {state.retryable && (
              <button
                className="btn primary"
                onClick={() => {
                  // re-resolve from the top: work → member entry → chapter.
                  // Retrying only the chapter would strand a reader whose
                  // failure happened before any chapter was known.
                  const request = requestedChapter.current;
                  if (request) void loadChapter(request.chapterId, request.restore);
                  else setReloadToken((n) => n + 1);
                }}
              >
                {t('重試')}
              </button>
            )}
            {/* only offered when the work itself resolved: sending a reader to
                the page of a work that was not found is a second dead end */}
            {state.code === 'chapter_not_found' && work?.firstChapterId && <button className="btn primary"
              onClick={() => void loadChapter(work.firstChapterId!, null)}>{t('閱讀目前版本第一章')}</button>}
            {work && <button className="btn" onClick={() => navigate(workPath(work))}>{t('回作品頁')}</button>}
            <button className="btn quiet" onClick={() => navigate('/')}>{t('回書庫')}</button>
          </div>
        </div>
      </div>
    );
  }
  // chapter-shaped placeholder, in the reader's own theme, so the first real
  // paragraph lands where the eye is already looking
  if (!chapter || !work || state.phase === 'loading') {
    return (
      <div className={`reader theme-${theme}`} data-testid="reader-loading"
        data-warmth={warmth ? settings.warmth : undefined}
        style={{ '--reader-warmth': warmth ?? undefined } as React.CSSProperties}>
        <SkeletonChapter />
      </div>
    );
  }

  const paginated = settings.mode === 'paginated';
  // one column per viewport: the strip carries no horizontal padding (see
  // reader.css), so column width + gap is exactly the distance a turn travels
  const columnWidth = pageWidth || 360;
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
      className={`reader theme-${theme}`}
      data-mode={settings.mode}
      data-chrome-visible={chromeVisible || undefined}
      data-warmth={warmth ? settings.warmth : undefined}
      style={{
        '--reader-font-size': `${settings.fontSize}px`,
        '--reader-line-height': settings.lineHeight,
        '--reader-para-spacing': `${settings.paragraphSpacing}em`,
        '--reader-warmth': warmth ?? undefined,
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
            <p className="reader-note" role="status">{t('章節內容已更新，已回到最接近的段落。')}</p>
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
          stripRef={stripRef} stripStyle={stripStyle} pageBoxRef={pageBoxRef} />
      </div>

      {/* Desktop page turns. The centred page box leaves the margins empty, and
          a pointer has no swipe — so the margin becomes the affordance, shown
          on hover/focus only (CSS) so it never sits over the prose. They sit
          left/right because that is the direction the page travels, while the
          tap bands in onTap are top/bottom; both reach the same stepPage, so
          whichever one the reader finds first is the right one. Not disabled at
          a chapter edge: stepPage rolls into the next chapter, exactly as the
          toolbar's chapter buttons do. */}
      {paginated && (
        <div className="reader-turns">
          <button
            className="reader-turn reader-turn-prev"
            aria-label={t('上一頁')}
            disabled={page <= 0 && !chapter.previousChapterId}
            onClick={() => stepPage(-1)}
          >
            <Icon name="back" />
          </button>
          <button
            className="reader-turn reader-turn-next"
            aria-label={t('下一頁')}
            disabled={page >= pageCount - 1 && !chapter.nextChapterId}
            onClick={() => stepPage(1)}
          >
            <Icon name="back" />
          </button>
        </div>
      )}

      {/* visual only: the toolbar's readout is the single live region, so the
          page number is never announced twice when the chrome is open */}
      {paginated && <p className="reader-pageinfo" aria-hidden="true">{page + 1} / {pageCount}</p>}

      <ReaderToolbar
        visible={chromeVisible}
        hasPrev={chapter.previousChapterId !== null}
        hasNext={chapter.nextChapterId !== null}
        progress={`${chapter.labelRaw || '—'}　·　${t('共 {n} 章', { n: count(work.chapterCount) })}`}
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
        onBack={() => navigate(workPath(work))}
        onConversion={(conversion) => changeLayout({ conversion })}
        onBookmark={() => {
          if (!member?.isMember) { setSyncNotice(t('登入後可加入書籤')); return; }
          if (bookmarkSaving) return;
          const p = captureAnchor();
          if (!p) return;
          setBookmarkSaving(true);
          void createBookmark({ workId: work.id, chapterId: p.chapterId, revisionId: p.revisionId, paragraphIndex: p.paragraphIndex })
            .then(({ id }) => { setBookmarkId(id); setSheet('bookmark'); setSyncNotice(t('已加入書籤')); })
            .catch(() => setSyncNotice(t('書籤加入失敗')))
            .finally(() => setBookmarkSaving(false));
        }}
      />

      <BottomSheet open={sheet === 'toc'} title={t('目錄（{n} 章）', { n: count(work.chapterCount) })} onClose={() => setSheet(null)}>
        <FullTextSearch workId={work.id} />
        <TableOfContents
          workId={work.id}
          currentChapterId={chapter.chapterId}
          onJump={(id) => goChapter(id)}
        />
      </BottomSheet>
      <BottomSheet open={sheet === 'report'} title={t('回報章節錯字')} onClose={() => setSheet(null)}>
        <ReportTypo key={`${chapter.chapterId}:${reportParagraphIndex}`} chapter={chapter} paragraphIndex={reportParagraphIndex} isMember={Boolean(member?.isMember)} />
      </BottomSheet>
      <BottomSheet open={sheet === 'bookmark'} title={t('書籤備註')} onClose={() => setSheet(null)}>
        {bookmarkId && <BookmarkNoteEditor key={bookmarkId} bookmarkId={bookmarkId} cancelLabel={t('略過')}
          onCancel={() => setSheet(null)} onSaved={() => { setSheet(null); setSyncNotice(t('已儲存書籤備註')); }} />}
      </BottomSheet>
      <BottomSheet open={sheet === 'settings'} title={t('閱讀設定')} onClose={() => setSheet(null)}>
        <button className="btn" onClick={openReport}>{t('回報錯字')}</button>
        <SpeechControls controller={speech} />
        <ReaderSettingsPanel settings={settings} onChange={updateSettings} onLayoutChange={changeLayout} />
      </BottomSheet>
    </div>
  );
}
