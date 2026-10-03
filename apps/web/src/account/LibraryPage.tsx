// 我的書庫 (§40): saved works as ruled rows with continue-reading, update
// markers, and favourite/follow changes without leaving the page.
import { useCallback, useEffect, useState } from 'react';
import { getLibrary, logout, removeFromLibrary, unfollow } from '../api/client.ts';
import type { LibraryEntry } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { refreshMe, useMe } from './useMe.ts';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { STATUS_LABEL, dateTime } from '../lib/format.ts';

export function LibraryPage() {
  const { me, loading } = useMe();
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // the shelf is keyset-paginated; refresh always restarts from the top so a
  // favourite/follow change cannot leave a stale cursor pointing mid-list
  const refresh = useCallback(() => {
    getLibrary()
      .then((r) => { setEntries(r.works); setNextCursor(r.nextCursor); })
      .catch(() => { setEntries([]); setNextCursor(null); });
  }, []);
  useEffect(() => { if (me) refresh(); }, [me, refresh]);

  const loadMore = () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    void getLibrary(nextCursor)
      .then((r) => {
        setEntries((prev) => [...(prev ?? []), ...r.works]);
        setNextCursor(r.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  };

  const act = (workId: string, p: Promise<unknown>) => {
    setBusyId(workId);
    void p.then(refresh).catch(() => undefined).finally(() => setBusyId(null));
  };

  if (loading) {
    return (
      <div className="page-head">
        <div className="head-line"><h1>我的書庫</h1></div>
        <SkeletonRows count={3} />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="auth-page">
        <EmptyState
          title="登入後這裡是你的書庫"
          body="收藏的作品、追更的新章提醒，以及跨裝置接續的閱讀位置，都會留在帳號裡。未登入也能閱讀，進度只存在這台裝置上。"
          action={<button className="btn primary" onClick={() => navigate('/login')}>登入</button>}
        />
      </div>
    );
  }

  const updated = entries?.filter((e) => e.hasUpdate).length ?? 0;

  return (
    <div className="library-page" data-testid="library">
      <header className="page-head">
        <div className="head-line">
          <h1>我的書庫</h1>
          {/* paginated: say "loaded", never imply a total we did not fetch */}
          {entries && (
            <span className="head-note">
              {nextCursor ? `已載入 ${entries.length} 部` : `${entries.length} 部`}
              {updated > 0 ? ` · ${updated} 部有更新` : ''}
            </span>
          )}
        </div>
        <nav className="subnav" aria-label="會員頁面">
          <button className="linkish" onClick={() => navigate('/me/bookmarks')}>我的書籤</button>
          <button className="linkish" onClick={() => navigate('/')}>到書庫找書</button>
          <button className="linkish" style={{ marginInlineStart: 'auto' }}
            onClick={() => void logout().then(refreshMe).then(() => navigate('/')).catch(() => undefined)}>
            登出
          </button>
        </nav>
      </header>

      {entries === null && <SkeletonRows count={3} label="載入書庫" />}

      {entries !== null && entries.length === 0 && (
        <EmptyState
          title="還沒有收藏的作品"
          body="在作品頁按「☆ 收藏」會把它放進這裡；按「追更」則會在有新章節時標記出來。"
          action={<button className="btn primary" onClick={() => navigate('/')}>去書庫逛逛</button>}
        />
      )}

      <div className="rows">
        {entries?.map((e) => (
          <div key={e.workId} className="row" data-testid="library-card">
            <div className="row-main">
              <button className="row-title" onClick={() => navigate(`/works/${e.workId}`)}>
                {e.title}
              </button>
              <div className="row-sub">
                <span className="row-meta">{e.author || '佚名'}</span>
                {e.hasUpdate && (
                  <span className="flag-new">有更新（{e.newChapterCount} 新章）</span>
                )}
                <span className="row-meta">
                  {e.lastReadAt ? `上次閱讀 ${dateTime(e.lastReadAt)}` : '尚未開始閱讀'}
                </span>
                <span className="row-actions">
                  <button className="chip primary" disabled={busyId === e.workId}
                    onClick={() => {
                      if (e.continueChapterId) navigate(`/read/${e.workId}/${e.continueChapterId}`);
                      else navigate(`/works/${e.workId}`);
                    }}>
                    {e.continueChapterId ? '繼續閱讀' : '開始閱讀'}
                  </button>
                  <button className="chip" disabled={busyId === e.workId}
                    onClick={() => act(e.workId, unfollow(e.workId))}>取消追更</button>
                  <button className="chip" disabled={busyId === e.workId}
                    onClick={() => act(e.workId, removeFromLibrary(e.workId))}>移出書庫</button>
                </span>
              </div>
            </div>
            <div className="row-rail">
              <span className={e.serialStatus === 'ongoing' ? 'status status-ongoing' : 'status'}>
                {e.serialStatus ? STATUS_LABEL[e.serialStatus] : '短篇'}
              </span>
            </div>
          </div>
        ))}
      </div>

      {nextCursor && (
        <button className="btn btn-block" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? '載入中…' : '載入更多'}
        </button>
      )}
    </div>
  );
}
