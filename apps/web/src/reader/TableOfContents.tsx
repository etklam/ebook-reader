// TableOfContents (§5.2): windowed fetch — a 5,000-chapter TOC loads 100 at a
// time and never pulls bodies. Irregular labels stay verbatim (never numerically
// normalized). Opening the sheet scrolls the current chapter into view (§04).
import { useEffect, useRef, useState } from 'react';
import { getToc } from '../api/client.ts';
import type { TocEntry } from '../api/types.ts';
import { SkeletonLines } from '../components/Skeleton.tsx';

const WINDOW = 100;

export function TableOfContents({
  workId, currentChapterId, onJump,
}: {
  workId: string;
  /** omitted on the work page, where no chapter is open */
  currentChapterId?: string | null;
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
    setError(false);
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

  // a failure with nothing on screen is the whole surface; a failure while
  // paging deeper keeps the chapters already listed and offers another go
  if (error && entries.length === 0) {
    return (
      <div className="empty">
        <h2>目錄載不出來</h2>
        <p>目錄是另一個請求，和正文無關——正在讀的章節不受影響。</p>
        <button className="btn" onClick={() => loadMore(0)}>重試</button>
      </div>
    );
  }

  if (loading && entries.length === 0) return <SkeletonLines count={9} label="載入目錄" />;

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
        <>
          {error && <p className="form-error toc-error" role="alert">這一段目錄沒載到，再試一次。</p>}
          <button className="btn toc-more" onClick={() => loadMore(entries.length)} disabled={loading}>
            {loading ? '載入中…' : `${error ? '重試' : '載入更多'}（已載入 ${entries.length}${total !== null ? ` / ${total}` : ''}）`}
          </button>
        </>
      )}
    </nav>
  );
}
