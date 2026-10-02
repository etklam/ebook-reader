// 我的書籤 (§41): newest first, open jumps to the frozen chapter+paragraph (the
// approximation notice comes from the reader), delete in place.
import { useCallback, useEffect, useState } from 'react';
import { deleteBookmark, getBookmarks } from '../api/client.ts';
import type { BookmarkEntry } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { useMe } from './useMe.ts';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { dateTime } from '../lib/format.ts';

export function BookmarksPage() {
  const { me, loading } = useMe();
  const [entries, setEntries] = useState<BookmarkEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getBookmarks().then((r) => setEntries(r.bookmarks)).catch(() => setEntries([]));
  }, []);
  useEffect(() => { if (me) refresh(); }, [me, refresh]);

  if (loading) {
    return (
      <div className="page-head">
        <div className="head-line"><h1>我的書籤</h1></div>
        <SkeletonRows count={3} />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="auth-page">
        <EmptyState
          title="書籤需要登入"
          body="書籤記住的是某一章的某一段，並鎖在當時的修訂版本上——所以它存在帳號裡，而不是這台裝置上。"
          action={<button className="btn primary" onClick={() => navigate('/login')}>登入</button>}
        />
      </div>
    );
  }

  return (
    <div className="bookmarks-page" data-testid="bookmarks">
      <header className="page-head">
        <div className="head-line">
          <h1>我的書籤</h1>
          {entries && <span className="head-note">{entries.length} 則</span>}
        </div>
        <nav className="subnav" aria-label="會員頁面">
          <button className="linkish" onClick={() => navigate('/me/library')}>我的書庫</button>
        </nav>
      </header>

      {entries === null && <SkeletonRows count={3} label="載入書籤" />}

      {entries !== null && entries.length === 0 && (
        <EmptyState
          title="還沒有書籤"
          body="閱讀時點一下正文叫出工具列，按「書籤」就會記下目前這一段。章節之後被修訂也找得回來——書籤會落在最接近的段落。"
          action={<button className="btn" onClick={() => navigate('/me/library')}>回我的書庫</button>}
        />
      )}

      <div className="rows">
        {entries?.map((b) => (
          <div key={b.id} className="row" data-testid="bookmark-card">
            <div className="row-main">
              <span className="row-title">{b.workTitle}</span>
              <div className="row-sub">
                <span className="row-meta">
                  {b.chapterLabel || '（無標籤）'}　·　第 {b.paragraphIndex + 1} 段
                </span>
                {b.note && <span className="row-desc">{b.note}</span>}
                <span className="row-meta">{dateTime(b.createdAt)}</span>
                <span className="row-actions">
                  <button className="chip primary"
                    onClick={() => navigate(`/read/${b.workId}/${b.chapterId}#p=${b.paragraphIndex}&rev=${b.revisionId}`)}>
                    開啟
                  </button>
                  <button className="chip" disabled={busyId === b.id}
                    onClick={() => {
                      setBusyId(b.id);
                      void deleteBookmark(b.id).then(refresh).catch(() => undefined).finally(() => setBusyId(null));
                    }}>
                    刪除
                  </button>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
