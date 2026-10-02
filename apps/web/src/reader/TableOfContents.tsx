// TableOfContents (§5.2): windowed fetch — a 5,000-chapter TOC loads 100 at a
// time and never pulls bodies. Irregular labels stay verbatim (never numerically
// normalized). Opening the sheet scrolls the current chapter into view (§04).
import { useEffect, useRef, useState } from 'react';
import { getToc } from '../api/client.ts';
import type { TocEntry } from '../api/types.ts';

const WINDOW = 100;

export function TableOfContents({
  workId, currentChapterId, onJump,
}: {
  workId: string;
  currentChapterId: string;
  onJump(chapterId: string): void;
}) {
  const [entries, setEntries] = useState<TocEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const centred = useRef(false);

  const loadMore = (offset: number) => {
    setLoading(true);
    getToc(workId, WINDOW, offset).then((r) => {
      setTotal(r.total);
      // keyed append; replaces on rewind (offset 0)
      setEntries((prev) => (offset === 0 ? r.chapters : [...prev, ...r.chapters]));
    }).catch(() => setError(true)).finally(() => setLoading(false));
  };

  useEffect(() => { setEntries([]); centred.current = false; loadMore(0); }, [workId]);

  // land on the chapter being read, not at chapter 1
  useEffect(() => {
    if (centred.current || !currentRef.current) return;
    centred.current = true;
    currentRef.current.scrollIntoView({ block: 'center' });
  }, [entries]);

  if (error) {
    return (
      <div className="empty">
        <h2>目錄載不出來</h2>
        <p>目錄是另一個請求，和正文無關——正在讀的章節不受影響。</p>
        <button className="btn" onClick={() => loadMore(0)}>重試</button>
      </div>
    );
  }

  if (loading && entries.length === 0) {
    return (
      <div role="status" aria-label="載入目錄">
        {Array.from({ length: 9 }, (_, i) => (
          <div className="sk sk-line" key={i} style={{ height: '1.1em', margin: '18px 0' }} aria-hidden="true" />
        ))}
      </div>
    );
  }

  const exhausted = total !== null && entries.length >= total;

  return (
    <nav aria-label="章節目錄">
      <ol className="toc-list">
        {entries.map((c) => {
          const current = c.id === currentChapterId;
          return (
            <li key={c.id}>
              <button
                className="toc-item"
                ref={current ? currentRef : undefined}
                onClick={() => onJump(c.id)}
                aria-current={current ? 'true' : undefined}
              >
                <span className="toc-label">{c.labelRaw || '（無標籤）'}</span>
                {c.title && <span className="toc-title">{c.title}</span>}
                {current && <span className="toc-here">閱讀中</span>}
              </button>
            </li>
          );
        })}
      </ol>
      {!exhausted && (
        <button className="btn toc-more" onClick={() => loadMore(entries.length)} disabled={loading}>
          {loading ? '載入中…' : `載入更多（已載入 ${entries.length}${total !== null ? ` / ${total}` : ''}）`}
        </button>
      )}
    </nav>
  );
}
