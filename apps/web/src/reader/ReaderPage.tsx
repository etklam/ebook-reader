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
  loadPosition, loadSettings, normalizeSettings, remapPosition, savePosition, saveSettings,
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
import {
  createProgressSync, pushPreferences,
  resolveMemberEntry, scheduleReadMarking, type MemberEntry,
} from './member-sync.ts';
import { createBookmark } from '../api/client.ts';
import { SkeletonChapter } from '../components/Skeleton.tsx';
import { count } from '../lib/format.ts';

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

// what to do about it — an error code on its own tells the reader nothing
const ERROR_HINT: Record<string, string> = {
  work_not_found: '它可能尚未發布，或連結已經失效。',
  chapter_not_found: '這一章可能在最近一次發布中被移除或重編了。回書庫重新進入可取得目前的目錄。',
  forbidden: '這部作品還沒有公開的發布版本，只有管理員看得到草稿。',
  content_unavailable: '正文暫時取不到，內容本身沒有遺失。稍後重試即可。',
  network: '看起來是連線中斷。重試一次通常就好；進度已經存在這台裝置上。',
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
  const [member, setMember] = useState<MemberEntry | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const captureRef = useRef<() => ReadingPosition | null>(() => null);

  const seqRef = useRef(0);           // stale-fetch guard (§13)
  const stripRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pendingAnchor = useRef<ReadingPosition | null>(null);
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

  captureRef.current = captureAnchor;

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
        // restore whenever the saved position is for THIS chapter — reload and
        // back-navigation land on the same paragraph regardless of entry path;
        // loadChapter ignores restores for other chapters
        await loadChapter(target, pos);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiRequestError) setState({ phase: 'error', code: e.code, retryable: false });
        else setState({ phase: 'error', code: 'network', retryable: true });
      }
    })();
    return () => { cancelled = true; };
  }, [workId]);

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
    rule.style.width = `${span > 0 ? Math.min(100, (vp.scrollTop / span) * 100) : 0}%`;
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
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      vp?.removeEventListener('scroll', onSave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [chapter, settings.mode, captureAnchor, savePositionDebounced, workId, paintRule]);

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
  useEffect(() => {
    if (!member?.isMember) { syncRef.current = null; return; }
    const sync = createProgressSync(
      workId,
      () => captureRef.current(),
      (server) => {
        // a newer device won (§30): adopt the account position deliberately
        setSyncNotice('已同步至帳號最新閱讀位置');
        pendingAnchor.current = server;
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
    const root = stripRef.current;
    const vp = viewportRef.current;
    if (!root || !vp) return;
    // two frames: fonts/layout settle before we measure (§11.3)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (settings.mode === 'scroll') {
        restoreScrollPosition(vp, root, anchor.paragraphIndex, anchor.fraction ?? 0);
        paintRule();
      } else {
        // the viewport div is shared across modes: drop any scroll-mode offset
        vp.scrollTop = 0;
        const count = columnCount(stripRef.current!, vp);
        setPageCount(count);
        setPage(clampPage(columnIndexForParagraph(root, anchor.paragraphIndex, vp, 0), count));
      }
    }));
  }, [state.phase, chapter, converted, settings.mode, settings.fontSize, settings.lineHeight, settings.paragraphSpacing, paintRule]);

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
    const p = captureAnchor();
    if (p) savePosition(workId, p);
    syncRef.current?.flush();
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
  // chapter-shaped placeholder, in the reader's own theme, so the first real
  // paragraph lands where the eye is already looking
  if (!chapter || state.phase === 'loading') {
    return (
      <div className={`reader theme-${settings.theme}`} data-testid="reader-loading">
        <SkeletonChapter />
      </div>
    );
  }
  if (state.phase === 'error') {
    return (
      <div className={`reader theme-${settings.theme}`}>
        <div className="reader-msg" data-testid="reader-error">
          <h2>{ERROR_TEXT[state.code] ?? '發生錯誤'}</h2>
          <p>{ERROR_HINT[state.code] ?? '請稍後再試，或回書庫換一本。'}</p>
          <code className="reader-err-code">{state.code}</code>
          <div className="msg-actions">
            {state.retryable && (
              <button className="btn primary" onClick={() => void loadChapter(chapter.chapterId, null)}>重試</button>
            )}
            <button className="btn" onClick={() => navigate('/')}>回書庫</button>
          </div>
        </div>
      </div>
    );
  }
  if (!work) {
    return (
      <div className={`reader theme-${settings.theme}`} data-testid="reader-loading">
        <SkeletonChapter />
      </div>
    );
  }

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
          style={paginated ? { width: `${((page + 1) / Math.max(1, pageCount)) * 100}%` } : undefined}
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
        data-testid="reader-viewport"
      >
        <ReaderContent paragraphs={paragraphs} resources={chapter?.resources}
          stripRef={stripRef} stripStyle={stripStyle} />
      </div>

      {paginated && <p className="reader-pageinfo" aria-live="polite">{page + 1} / {pageCount}</p>}

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
        onPrevPage={() => { if (turnPage(-1) !== 'moved') goChapter(chapter.previousChapterId); }}
        onNextPage={() => { if (turnPage(1) !== 'moved') goChapter(chapter.nextChapterId); }}
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
