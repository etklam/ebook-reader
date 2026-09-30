// 我的書籤 (§41): grouped by recency, open jumps to the frozen
// chapter+paragraph (approximation notice comes from the reader), delete.
import { useCallback, useEffect, useState } from 'react';
import { deleteBookmark, getBookmarks } from '../api/client.ts';
import type { BookmarkEntry } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { useMe } from './useMe.ts';

export function BookmarksPage() {
  const { me, loading } = useMe();
  const [entries, setEntries] = useState<BookmarkEntry[] | null>(null);

  const refresh = useCallback(() => {
    getBookmarks().then((r) => setEntries(r.bookmarks)).catch(() => setEntries([]));
  }, []);
  useEffect(() => { if (me) refresh(); }, [me, refresh]);

  if (loading) return <p className="muted page-pad">載入中…</p>;
  if (!me) {
    return (
      <div className="auth-page">
        <p>登入後即可使用書籤。</p>
        <button className="reader-btn primary" onClick={() => navigate('/login')}>登入</button>
      </div>
    );
  }

  return (
    <div className="bookmarks-page" data-testid="bookmarks">
      <h1>我的書籤</h1>
      {entries === null && <p className="muted">載入中…</p>}
      {entries !== null && entries.length === 0 && <p className="muted">還沒有書籤。閱讀時可從工具列加入。</p>}
      <div className="work-list">
        {entries?.map((b) => (
          <div key={b.id} className="work-card" data-testid="bookmark-card">
            <div className="work-card-body">
              <span className="work-title">{b.workTitle}</span>
              <span className="work-meta">{b.chapterLabel || '（無標籤）'} · 第 {b.paragraphIndex + 1} 段</span>
              {b.note && <span className="work-desc">{b.note}</span>}
              <span className="muted">{new Date(b.createdAt).toLocaleString('zh-Hant')}</span>
              <span className="row-actions">
                <button className="reader-btn chip primary"
                  onClick={() => navigate(`/read/${b.workId}/${b.chapterId}#p=${b.paragraphIndex}&rev=${b.revisionId}`)}>
                  開啟
                </button>
                <button className="reader-btn chip" onClick={() => deleteBookmark(b.id).then(refresh).catch(() => undefined)}>刪除</button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
