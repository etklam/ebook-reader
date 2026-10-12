import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client.ts';

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
type SearchResponse = { query: string; total: number; truncated: boolean; results: SearchResult[] };

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

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!value || busy) return;
    const id = ++requestId.current;
    setBusy(true); setError(''); setResponse(null);
    try {
      const result = await api<SearchResponse>(`/api/reader/works/${workId}/search?q=${encodeURIComponent(value)}`);
      if (requestId.current === id) setResponse(result);
    } catch (e) {
      if (requestId.current === id) setError(e instanceof Error && 'status' in e && e.status === 403
        ? '這部作品尚未公開。' : '搜尋失敗，請稍後再試。');
    } finally {
      if (requestId.current === id) setBusy(false);
    }
  };

  return (
    <section aria-label="全文搜尋">
      <h2>搜尋本書</h2>
      <form onSubmit={search}>
        <div className="form-row">
          <input className="input" type="search" value={query} maxLength={100}
            aria-label="搜尋本書內容" placeholder="輸入關鍵字" onChange={(event) => setQuery(event.target.value)} />
          <button className="btn primary" disabled={busy || !query.trim()}>{busy ? '搜尋中…' : '搜尋'}</button>
        </div>
      </form>
      <p className="hint">搜尋目前可閱讀的版本，支援繁簡字互查。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy && <p className="hint" role="status">正在搜尋章節內容…</p>}
      {response && <>
        <p className="hint" role="status">{response.total ? `找到 ${response.total} 個章節` : '沒有找到相符章節'}{response.truncated ? '，只顯示前 50 個。' : '。'}</p>
        {response.results.length > 0 && <div className="rows">
          {response.results.map((result) => (
            <a className="row" key={result.chapterId} href={result.href}>
              <span className="row-main">
                <span className="row-title">{result.title || result.labelRaw}</span>
                <span className="row-author">{result.labelRaw} · 第 {result.paragraphIndex + 1} 段</span>
                <span className="row-meta">{highlighted(result.snippet, result.matchStart, result.matchLength)}</span>
              </span>
            </a>
          ))}
        </div>}
      </>}
    </section>
  );
}
