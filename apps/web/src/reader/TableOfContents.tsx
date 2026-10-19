// Bounded metadata windows use the active publication's order and version.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, getToc } from '../api/client.ts';
import type { TocEntry } from '../api/types.ts';
import { SkeletonLines } from '../components/Skeleton.tsx';
import { t } from '../i18n/translate.ts';

const WINDOW = 100;
type Request = { offset: number; direction: 'replace' | 'before' | 'after'; version?: string; limit?: number };

export function TableOfContents({ workId, currentChapterId, onJump }: {
  workId: string;
  currentChapterId?: string | null;
  /** the entry is passed alongside the id so callers can build a canonical
   *  `/read/<work>/<label>-<publicId>` path without re-fetching the TOC */
  onJump(chapterId: string, entry: TocEntry): void;
}) {
  const [entries, setEntries] = useState<TocEntry[]>([]);
  const [query, setQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const controller = useRef<AbortController | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitQuery = (value: string) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setSearchQuery(value);
  };
  useEffect(() => {
    debounceTimer.current = setTimeout(() => setSearchQuery(query), 250);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [query]);
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [location, setLocation] = useState<{ target: 'current' | 'latest'; nonce: number }>({ target: 'current', nonce: 0 });
  const [page, setPage] = useState<{ total: number; start: number; next: number | null; version: string } | null>(null);
  const [anchorMissing, setAnchorMissing] = useState(false);
  const [error, setError] = useState<'request' | 'version' | null>(null);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);
  const retry = useRef<Request>({ offset: 0, direction: 'replace' });
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const centre = useRef(true);

  const load = useCallback((request: Request) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const generation = ++requestId.current;
    retry.current = request;
    setLoading(true);
    setError(null);
    const replacing = request.direction === 'replace';
    void getToc(workId, request.limit ?? WINDOW, request.offset, {
      q: searchQuery.trim(), order, version: request.version,
      ...(replacing && !searchQuery.trim() ? location.target === 'latest' ? { latest: true }
        : currentChapterId ? { aroundChapterId: currentChapterId } : {} : {}),
    }, abort.signal).then((response) => {
      if (generation !== requestId.current) return;
      setEntries((previous) => replacing ? response.chapters
        : request.direction === 'before' ? [...response.chapters, ...previous] : [...previous, ...response.chapters]);
      setPage((previous) => ({
        total: response.total, version: response.version,
        start: request.direction === 'after' && previous ? previous.start : response.offset,
        next: request.direction === 'before' && previous ? previous.next : response.nextOffset,
      }));
      if (replacing) setAnchorMissing(response.anchorMissing);
    }).catch((failure: unknown) => {
      if (generation !== requestId.current || abort.signal.aborted) return;
      setError(failure instanceof ApiRequestError && failure.code === 'toc_version_changed' ? 'version' : 'request');
    }).finally(() => { if (generation === requestId.current) setLoading(false); });
  }, [workId, currentChapterId, searchQuery, order, location]);

  useEffect(() => {
    setAnchorMissing(false);
    centre.current = true;
    load({ offset: 0, direction: 'replace' });
    // Counter invalidation intentionally increments the latest request generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { requestId.current++; controller.current?.abort(); };
  }, [load]);

  useEffect(() => {
    if (!centre.current || !currentRef.current) return;
    centre.current = false;
    currentRef.current.scrollIntoView({ block: 'center' });
  }, [entries]);

  const locate = (target: 'current' | 'latest') => {
    requestId.current++;
    setQuery(''); commitQuery('');
    setLocation((previous) => ({ target, nonce: previous.nonce + 1 }));
  };

  const latestId = location.target === 'latest' && !query.trim()
    ? entries.reduce<TocEntry | null>((latest, entry) => !latest || entry.editorialPosition > latest.editorialPosition ? entry : latest, null)?.id
    : null;

  return (
    <nav aria-label={t('章節目錄')} aria-busy={loading}>
      <div className="field">
        <label htmlFor="toc-search">{t('搜尋章名或章號')}</label>
        <input id="toc-search" className="input" type="search" value={query} maxLength={200}
          onChange={(event) => {
            requestId.current++;
            controller.current?.abort();
            setQuery(event.target.value);
            if (!event.target.value) commitQuery('');
            setLocation((previous) => previous.target === 'current' ? previous : { ...previous, target: 'current' });
          }} />
      </div>
      <div className="row-actions">
        <label className="field">{t('章節順序')}
          <select className="input" value={order} onChange={(event) => {
            requestId.current++;
            commitQuery(query);
            setOrder(event.target.value as 'asc' | 'desc');
          }}>
            <option value="asc">{t('正序')}</option><option value="desc">{t('倒序')}</option>
          </select>
        </label>
        {currentChapterId && <button className="btn" onClick={() => locate('current')}>{t('回到目前章節')}</button>}
        <button className="btn" onClick={() => locate('latest')}>{t('前往最新章目錄位置')}</button>
      </div>
      {anchorMissing && <p role="status" className="hint">{t('目前章節已不在這個版本，先顯示可閱讀的目錄。')}</p>}
      {error === 'version' && <p className="form-error" role="alert">{t('作品已發布新版本，請重新載入目錄。')}</p>}
      {error === 'request' && <p className="form-error" role="alert">{t('這一段目錄沒載到，既有清單仍保留。')}</p>}
      {error && <button className="btn" onClick={() => error === 'version'
        ? locate(location.target) : load(retry.current)}>{error === 'version' ? t('重新載入目錄') : t('重新載入這一段')}</button>}
      {loading && entries.length === 0 && <SkeletonLines count={9} label={t('載入目錄')} />}
      {!loading && !error && page?.total === 0 && <p role="status">{query.trim() ? t('找不到符合的章名或章號，清除搜尋可回到目前章節附近。') : t('目前沒有可閱讀的章節。')}</p>}
      {query && <button className="btn" onClick={() => locate('current')}>{t('清除搜尋')}</button>}
      {page && page.start > 0 && <button className="btn toc-more" disabled={loading || error === 'version'}
        onClick={() => load({ offset: Math.max(0, page.start - WINDOW), limit: Math.min(WINDOW, page.start), direction: 'before', version: page.version })}>
        {t('載入前段目錄')}
      </button>}
      <ol className="toc-list">
        {entries.map((chapter) => {
          const current = chapter.id === currentChapterId;
          return <li key={chapter.id}>
            <button className="toc-item" ref={(latestId ? chapter.id === latestId : current) ? currentRef : undefined}
              onClick={() => onJump(chapter.id, chapter)} aria-current={current ? 'true' : undefined}>
              <span className="toc-label">{chapter.labelRaw || t('（無標籤）')}</span>
              {chapter.title && <span className="toc-title">{chapter.title}</span>}
              {current && <span className="toc-here">{t('閱讀中')}</span>}
            </button>
          </li>;
        })}
      </ol>
      {page?.next !== null && page && <button className="btn toc-more" disabled={loading || error === 'version'}
        onClick={() => load({ offset: page.next!, direction: 'after', version: page.version })}>
        {loading ? t('載入中…') : t('載入後段目錄（已載入 {loaded} / {total}）', { loaded: entries.length, total: page.total })}
      </button>}
    </nav>
  );
}
