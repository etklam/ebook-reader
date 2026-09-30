// TableOfContents (§5.2): windowed fetch — a 5,000-chapter TOC loads 100 at a
// time and never pulls bodies. Irregular labels stay verbatim (never
// numerically normalized).
import { useEffect, useState } from 'react';
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

  const loadMore = (offset: number) => {
    getToc(workId, WINDOW, offset).then((r) => {
      setTotal(r.total);
      setEntries((prev) => {
        // keyed append; replaces on rewind (offset 0)
        const merged = offset === 0 ? r.chapters : [...prev, ...r.chapters];
        return merged;
      });
    }).catch(() => setError(true));
  };

  useEffect(() => { loadMore(0); setEntries([]); }, [workId]);

  if (error) return <p className="reader-msg">目錄載入失敗。</p>;
  const exhausted = total !== null && entries.length >= total;

  return (
    <nav aria-label="章節目錄">
      <ol className="toc-list">
        {entries.map((c) => (
          <li key={c.id}>
            <button
              className={`toc-item${c.id === currentChapterId ? ' current' : ''}`}
              onClick={() => onJump(c.id)}
              aria-current={c.id === currentChapterId ? 'true' : undefined}
            >
              <span className="toc-label">{c.labelRaw || '（無標籤）'}</span>
              {c.title && <span className="toc-title">{c.title}</span>}
            </button>
          </li>
        ))}
      </ol>
      {!exhausted && (
        <button className="reader-btn toc-more" onClick={() => loadMore(entries.length)} disabled={total === null && entries.length === 0}>
          載入更多（已載入 {entries.length}{total !== null ? ` / ${total}` : ''}）
        </button>
      )}
    </nav>
  );
}
