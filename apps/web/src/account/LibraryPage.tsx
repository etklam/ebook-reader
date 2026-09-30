// 我的書庫 (§40): saved works with continue-reading, update badges, and
// favorite/remove + follow/unfollow without leaving the page.
import { useCallback, useEffect, useState } from 'react';
import { getLibrary, removeFromLibrary, unfollow } from '../api/client.ts';
import type { LibraryEntry } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { useMe } from './useMe.ts';

const STATUS_LABEL = { ongoing: '連載中', completed: '已完結', paused: '暫停' } as const;

export function LibraryPage() {
  const { me, loading } = useMe();
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);

  const refresh = useCallback(() => {
    getLibrary().then((r) => setEntries(r.works)).catch(() => setEntries([]));
  }, []);
  useEffect(() => { if (me) refresh(); }, [me, refresh]);

  if (loading) return <p className="muted page-pad">載入中…</p>;
  if (!me) {
    return (
      <div className="auth-page">
        <p>登入後即可使用書庫、追更與進度同步。</p>
        <button className="reader-btn primary" onClick={() => navigate('/login')}>登入</button>
      </div>
    );
  }

  return (
    <div className="library-page" data-testid="library">
      <h1>我的書庫</h1>
      <div className="detail-cta" style={{ marginBottom: 12 }}>
        <button className="reader-btn" onClick={() => navigate('/me/bookmarks')}>我的書籤</button>
      </div>
      {entries === null && <p className="muted">載入中…</p>}
      {entries !== null && entries.length === 0 && <p className="muted">還沒有收藏的作品。</p>}
      <div className="work-list">
        {entries?.map((e) => (
          <div key={e.workId} className="work-card" data-testid="library-card">
            <div className="work-card-body">
              <button className="linkish work-title" onClick={() => navigate(`/works/${e.workId}`)}>{e.title}</button>
              <span className="work-meta">
                {e.serialStatus ? STATUS_LABEL[e.serialStatus] : '短篇'}
                {e.hasUpdate && <b className="update-badge"> 有更新（{e.newChapterCount} 新章）</b>}
              </span>
              {e.lastReadAt && <span className="muted">上次閱讀：{new Date(e.lastReadAt).toLocaleString('zh-Hant')}</span>}
              <span className="row-actions">
                <button className="reader-btn chip primary" onClick={() => {
                  if (e.continueChapterId) navigate(`/read/${e.workId}/${e.continueChapterId}`);
                  else navigate(`/works/${e.workId}`);
                }}>{e.continueChapterId ? '繼續閱讀' : '開始閱讀'}</button>
                <button className="reader-btn chip" onClick={() => unfollow(e.workId).then(refresh).catch(() => undefined)}>取消追更</button>
                <button className="reader-btn chip" onClick={() => removeFromLibrary(e.workId).then(refresh).catch(() => undefined)}>移出書庫</button>
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="muted page-pad">
        想追更多作品？到<a className="linkish" onClick={() => navigate('/')} href="/">書庫</a>逛逛。
      </p>
    </div>
  );
}
