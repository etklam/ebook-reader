import { useEffect, useRef, useState, type FormEvent } from 'react';
import { navigate } from '../App.tsx';
import { api } from '../api/client.ts';
import { t } from '../i18n/translate.ts';

type SearchResult = {
  chapterId: string;
  labelRaw: string;
  title: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
  paragraphIndex: number;
  href: string;
};
type SearchResponse = { query: string; total: null; offset: number; nextCursor: string | null; hasMore: boolean; results: SearchResult[] };

function highlighted(text: string, start: number, length: number) {
  const safeStart = Math.max(0, Math.min(text.length, start));
  const end = Math.max(safeStart, Math.min(text.length, safeStart + length));
  return <>{text.slice(0, safeStart)}<mark>{text.slice(safeStart, end)}</mark>{text.slice(end)}</>;
}

export function FullTextSearch({ workId }: { workId: string }) {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    requestId.current += 1;
    setResponse(null); setError(''); setBusy(false); setQuery('');
    setCursors([null]); setPageIndex(0);
    return () => { requestId.current += 1; };
  }, [workId]);

  const fetchPage = async (value: string, index = 0, cursor: string | null = null) => {
    if (!value || busy) return;
    const id = ++requestId.current;
    setBusy(true); setError(''); setResponse(null);
    try {
      const params = new URLSearchParams({ q: value });
      if (cursor) params.set('cursor', cursor);
      const result = await api<SearchResponse>(`/api/reader/works/${workId}/search?${params}`);
      if (requestId.current === id) {
        setResponse(result); setPageIndex(index);
        setCursors((previous) => [...previous.slice(0, index), cursor, ...(result.nextCursor ? [result.nextCursor] : [])]);
      }
    } catch (e) {
      if (requestId.current === id) setError(e instanceof Error && 'status' in e && e.status === 403
        ? t('這部作品尚未公開。') : e instanceof Error && 'status' in e && e.status === 429
          ? t('搜尋次數較多，請一分鐘後再試。') : e instanceof Error && 'status' in e && e.status === 409
            ? t('作品版本或內容已變動，請重新搜尋；若仍失敗，請稍後重試。') : t('搜尋失敗，請稍後再試。'));
    } finally {
      if (requestId.current === id) setBusy(false);
    }
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    setCursors([null]); setPageIndex(0);
    void fetchPage(query.trim());
  };

  return (
    <section aria-label={t('全文搜尋')}>
      <h2>{t('搜尋本書')}</h2>
      <form onSubmit={search}>
        <div className="form-row">
          <input className="input" type="search" value={query} maxLength={100}
            aria-label={t('搜尋本書內容')} placeholder={t('輸入關鍵字')} onChange={(event) => {
              requestId.current += 1;
              setBusy(false); setResponse(null); setError('');
              setCursors([null]); setPageIndex(0);
              setQuery(event.target.value);
            }} />
          <button className="btn primary" disabled={busy || !query.trim()}>{busy ? t('搜尋中…') : t('搜尋')}</button>
        </div>
      </form>
      <p className="hint">{t('搜尋目前可閱讀的版本，支援繁簡字互查。')}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p className="hint" role="status">{t('正在搜尋章節內容…')}</p>}
      {response && <>
        <p className="hint" role="status">{response.results.length
          ? t(response.hasMore
              ? '顯示第 {from}–{to} 個相符章節，還有更多結果。'
              : '顯示第 {from}–{to} 個相符章節。',
            { from: response.offset + 1, to: response.offset + response.results.length })
          : t('沒有找到相符章節。')}</p>
        {response.results.length > 0 && <div className="rows">
          {response.results.map((result) => (
            <a className="row" key={result.chapterId} href={result.href} onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault(); navigate(result.href);
            }}>
              <span className="row-main">
                <span className="row-title">{result.title || result.labelRaw}</span>
                <span className="row-author">{result.labelRaw} · {t('第 {n} 段', { n: result.paragraphIndex + 1 })}</span>
                <span className="row-meta">{highlighted(result.snippet, result.matchStart, result.matchLength)}</span>
              </span>
            </a>
          ))}
        </div>}
        {(pageIndex > 0 || response.hasMore) && <div className="form-row" aria-label={t('搜尋結果分頁')}>
          <button className="btn" disabled={busy || pageIndex === 0}
            onClick={() => void fetchPage(response.query, pageIndex - 1, cursors[pageIndex - 1])}>{t('上一頁')}</button>
          <button className="btn" disabled={busy || !response.nextCursor}
            onClick={() => { if (response.nextCursor) void fetchPage(response.query, pageIndex + 1, response.nextCursor); }}>{t('下一頁')}</button>
        </div>}
      </>}
    </section>
  );
}
