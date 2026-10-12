// 我的書庫 (§40): saved works as ruled rows with continue-reading, update
// markers, and favourite/follow changes without leaving the page. Removals are
// one tap and then undoable, rather than one tap behind a confirmation.
import { useCallback, useEffect, useState } from 'react';
import { addToLibrary, follow, getLibrary, markFollowSeen, removeFromLibrary, unfollow } from '../api/client.ts';
import type { LibraryEntry } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { useMe } from './useMe.ts';
import { MemberNav } from './MemberNav.tsx';
import { refreshUpdates } from './useUpdates.ts';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { Toast } from '../components/Toast.tsx';
import { STATUS_LABEL, dateTime } from '../lib/format.ts';

/** a line of confirmation, optionally with the action that takes it back */
interface Note { message: string; undo?(): Promise<unknown> }

export function LibraryPage() {
  const { me, loading } = useMe();
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  // the shelf is keyset-paginated; refresh always restarts from the top so a
  // favourite/follow change cannot leave a stale cursor pointing mid-list
  const refresh = useCallback(() => {
    setFailed(false);
    return getLibrary()
      .then((r) => { setEntries(r.works); setNextCursor(r.nextCursor); })
      // an empty shelf and an unreachable shelf are different facts, and
      // "還沒有收藏的作品" is the wrong one to tell a reader who has twelve
      .catch(() => { setFailed(true); setNextCursor(null); });
  }, []);
  useEffect(() => { if (me) void refresh(); }, [me, refresh]);

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

  const act = (workId: string, p: Promise<unknown>, done?: Note) => {
    setBusyId(workId);
    void p
      .then(refresh)
      .then(() => refreshUpdates(true))
      .then(() => setNote(done ?? null))
      // the shelf is refreshed either way, so the row already tells the truth;
      // the note is there so a failed tap is not silence
      .catch(() => setNote({ message: '這次沒有成功，請再試一次' }))
      .finally(() => setBusyId(null));
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
        <MemberNav current="library" onError={(message) => setNote({ message })} />
      </header>

      {entries === null && !failed && <SkeletonRows count={3} label="載入書庫" />}

      {failed && (
        <EmptyState
          title="書庫暫時載不出來"
          body="收藏本身沒有受影響，只是這次沒取到。重試一次通常就好。"
          action={<button className="btn" onClick={() => void refresh()}>重試</button>}
        />
      )}

      {!failed && entries !== null && entries.length === 0 && (
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
                  {e.following && (
                    <button className="chip" disabled={busyId === e.workId}
                      onClick={() => act(e.workId, unfollow(e.workId), {
                        message: `已取消追更《${e.title}》`,
                        undo: async () => {
                          await follow(e.workId);
                          if (e.lastSeenVersion !== null) await markFollowSeen(e.workId, e.lastSeenVersion);
                        },
                      })}>取消追更</button>
                  )}
                  <button className="chip" disabled={busyId === e.workId}
                    onClick={() => act(e.workId, removeFromLibrary(e.workId), {
                      message: `已移出書庫《${e.title}》`,
                      undo: () => addToLibrary(e.workId),
                    })}>移出書庫</button>
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

      {note && (
        <Toast
          message={note.message}
          actionLabel={note.undo ? '復原' : undefined}
          onAction={() => {
            const undo = note.undo;
            setNote(null);
            void undo?.()
              .then(refresh)
              .then(() => refreshUpdates(true))
              .catch(() => {
                void refresh();
                setNote({ message: '復原失敗，請重新確認狀態' });
              });
          }}
          onDismiss={() => setNote(null)}
        />
      )}
    </div>
  );
}
