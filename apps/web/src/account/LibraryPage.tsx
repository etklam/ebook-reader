// 我的書庫 (§40): saved works as ruled rows with continue-reading, update
// markers, and favourite/follow changes without leaving the page. Removals are
// one tap and then undoable, rather than one tap behind a confirmation.
import { useCallback, useEffect, useRef, useState } from 'react';
import { addToLibrary, follow, getLibrary, markFollowSeen, removeFromLibrary, unfollow, updateLibraryEntry } from '../api/client.ts';
import type { LibraryEntry, LibraryReadingStatus } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { readPath, workPath } from '../lib/slug.ts';
import { useMe } from './useMe.ts';
import { MemberNav } from './MemberNav.tsx';
import { refreshUpdates } from './useUpdates.ts';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { Toast } from '../components/Toast.tsx';
import { statusLabel, dateTime } from '../lib/format.ts';
import { t } from '../i18n/translate.ts';

/** a line of confirmation, optionally with the action that takes it back */
interface Note { message: string; undo?(): Promise<unknown> }
// source strings, translated at the render site (a constant runs once at import)
const READING_LABELS: Record<LibraryReadingStatus, string> = {
  want: '想讀', reading: '閱讀中', finished: '已讀', paused: '擱置',
};

function LibraryMetadataForm({ entry, groups, busy, save }: {
  entry: LibraryEntry; groups: string[]; busy: boolean;
  save(status: LibraryReadingStatus, groupName: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(entry.readingStatus);
  const [groupName, setGroupName] = useState(entry.groupName ?? '');
  if (!editing) return <button className="chip library-organize" disabled={busy} onClick={() => setEditing(true)}>{t('整理')}</button>;
  return (
    <form className="library-edit" onSubmit={(event) => { event.preventDefault(); save(status, groupName); }}>
      <label className="field">{t('閱讀狀態')}
        <select className="input" value={status} disabled={busy} onChange={(event) => setStatus(event.target.value as LibraryReadingStatus)}>
          {Object.entries(READING_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </label>
      <label className="field">{t('分組')}
        <input className="input" value={groupName} maxLength={40} list={`groups-${entry.workId}`} placeholder={t('留空為未分組')}
          disabled={busy} onChange={(event) => setGroupName(event.target.value)} />
        <datalist id={`groups-${entry.workId}`}>{groups.map((group) => <option key={group} value={group} />)}</datalist>
      </label>
      <button className="chip primary" disabled={busy} type="submit">{t('儲存')}</button>
      <button className="chip" disabled={busy} type="button" onClick={() => setEditing(false)}>{t('取消')}</button>
    </form>
  );
}

export function LibraryPage() {
  const { me, loading } = useMe();
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [readingStatus, setReadingStatus] = useState<LibraryReadingStatus | ''>('');
  const [groupFilter, setGroupFilter] = useState('*');
  const [groups, setGroups] = useState<string[]>([]);
  const requestVersion = useRef(0);

  // the shelf is keyset-paginated; refresh always restarts from the top so a
  // favourite/follow change cannot leave a stale cursor pointing mid-list
  const refresh = useCallback(() => {
    const version = ++requestVersion.current;
    setFailed(false);
    return getLibrary(undefined, { readingStatus: readingStatus || undefined, groupName: groupFilter === '*' ? undefined : groupFilter.slice(1) })
      .then((r) => {
        if (version !== requestVersion.current) return;
        setEntries(r.works); setNextCursor(r.nextCursor); setGroups(r.groups);
      })
      // an empty shelf and an unreachable shelf are different facts, and
      // "還沒有收藏的作品" is the wrong one to tell a reader who has twelve
      .catch(() => { if (version === requestVersion.current) { setFailed(true); setNextCursor(null); } });
  }, [readingStatus, groupFilter]);
  useEffect(() => {
    if (me) { setEntries(null); setNextCursor(null); void refresh(); }
    // Counter invalidation intentionally increments the latest request generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { requestVersion.current++; };
  }, [me, refresh]);

  const loadMore = () => {
    if (!nextCursor) return;
    const version = requestVersion.current;
    setLoadingMore(true);
    void getLibrary(nextCursor, { readingStatus: readingStatus || undefined, groupName: groupFilter === '*' ? undefined : groupFilter.slice(1) })
      .then((r) => {
        if (version !== requestVersion.current) return;
        setEntries((prev) => [...(prev ?? []), ...r.works]);
        setNextCursor(r.nextCursor);
      })
      .catch(() => setNote({ message: t('更多作品載入失敗，請再試一次') }))
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
      .catch(() => setNote({ message: t('這次沒有成功，請再試一次') }))
      .finally(() => setBusyId(null));
  };

  if (loading) {
    return (
      <div className="page-head">
        <div className="head-line"><h1>{t('我的書庫')}</h1></div>
        <SkeletonRows count={3} />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="auth-page">
        <EmptyState
          title={t('登入後這裡是你的書庫')}
          body={t('收藏的作品、追更的新章提醒，以及跨裝置接續的閱讀位置，都會留在帳號裡。未登入也能閱讀，進度只存在這台裝置上。')}
          action={<button className="btn primary" onClick={() => navigate('/login')}>{t('登入')}</button>}
        />
      </div>
    );
  }

  const updated = entries?.filter((e) => e.hasUpdate).length ?? 0;

  return (
    <div className="library-page" data-testid="library">
      <header className="page-head">
        <div className="head-line">
          <h1>{t('我的書庫')}</h1>
          {/* paginated: say "loaded", never imply a total we did not fetch */}
          {entries && (
            <span className="head-note">
              {nextCursor ? t('已載入 {n} 部', { n: entries.length }) : t('{n} 部', { n: entries.length })}
              {updated > 0 ? ` · ${t('{n} 部有更新', { n: updated })}` : ''}
            </span>
          )}
        </div>
        <MemberNav current="library" onError={(message) => setNote({ message })} />
        <div className="library-filters">
          <label className="field">{t('閱讀狀態')}
            <select className="input" value={readingStatus} disabled={busyId !== null || loadingMore}
              onChange={(event) => setReadingStatus(event.target.value as LibraryReadingStatus | '')}>
              <option value="">{t('全部狀態')}</option>
              {Object.entries(READING_LABELS).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
          </label>
          <label className="field">{t('分組')}
            <select className="input" value={groupFilter} disabled={busyId !== null || loadingMore} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="*">{t('全部分組')}</option><option value=":">{t('未分組')}</option>
              {[...new Set([...groups, ...(groupFilter !== ':' && groupFilter !== '*' ? [groupFilter.slice(1)] : [])])].map((group) =>
                <option key={group} value={`:${group}`}>{group}</option>)}
            </select>
          </label>
        </div>
      </header>

      {entries === null && !failed && <SkeletonRows count={3} label={t('載入書庫')} />}

      {failed && (
        <EmptyState
          title={t('書庫暫時載不出來')}
          body={t('收藏本身沒有受影響，只是這次沒取到。重試一次通常就好。')}
          action={<button className="btn" onClick={() => void refresh()}>{t('重試')}</button>}
        />
      )}

      {!failed && entries !== null && entries.length === 0 && (
        <EmptyState
          title={readingStatus || groupFilter !== '*' ? t('沒有符合篩選的作品') : t('還沒有收藏的作品')}
          body={readingStatus || groupFilter !== '*' ? t('試試其他閱讀狀態或分組。') : t('在作品頁按「☆ 收藏」會把它放進這裡；按「追更」則會在有新章節時標記出來。')}
          action={<button className="btn primary" onClick={() => navigate('/')}>{t('去書庫逛逛')}</button>}
        />
      )}

      <div className="rows">
        {entries?.map((e) => (
          <div key={e.workId} className="row" data-testid="library-card">
            <div className="row-main">
              <button className="row-title" onClick={() => navigate(workPath({ id: e.workId, title: e.title }))}>
                {e.title}
              </button>
              <div className="row-sub">
                <span className="row-meta">{e.author || t('佚名')}</span>
                <span className="row-meta">{t(READING_LABELS[e.readingStatus])} · {e.groupName || t('未分組')}</span>
                {e.hasUpdate && (
                  <span className="flag-new">{t('有更新（{n} 新章）', { n: e.newChapterCount })}</span>
                )}
                <span className="row-meta">
                  {e.lastReadAt ? t('上次閱讀 {at}', { at: dateTime(e.lastReadAt) }) : t('尚未開始閱讀')}
                </span>
                <span className="row-actions">
                  <button className="chip primary" disabled={busyId === e.workId}
                    onClick={() => {
                      if (e.continueChapterId) navigate(readPath({ id: e.workId, title: e.title }, { id: e.continueChapterId }));
                      else navigate(workPath({ id: e.workId, title: e.title }));
                    }}>
                    {e.continueChapterId ? t('繼續閱讀') : t('開始閱讀')}
                  </button>
                  {e.following && (
                    <button className="chip" disabled={busyId === e.workId}
                      onClick={() => act(e.workId, unfollow(e.workId), {
                        message: t('已取消追更《{title}》', { title: e.title }),
                        undo: async () => {
                          await follow(e.workId);
                          if (e.lastSeenVersion !== null) await markFollowSeen(e.workId, e.lastSeenVersion);
                        },
                      })}>{t('取消追更')}</button>
                  )}
                  <button className="chip" disabled={busyId === e.workId}
                    onClick={() => act(e.workId, removeFromLibrary(e.workId), {
                      message: t('已移出書庫《{title}》', { title: e.title }),
                      undo: async () => {
                        await addToLibrary(e.workId);
                        await updateLibraryEntry(e.workId, { readingStatus: e.readingStatus, groupName: e.groupName });
                      },
                    })}>{t('移出書庫')}</button>
                </span>
              </div>
              <LibraryMetadataForm key={`${e.workId}-${e.readingStatus}-${e.groupName}`} entry={e} groups={groups} busy={busyId !== null}
                save={(status, groupName) => act(e.workId, updateLibraryEntry(e.workId, { readingStatus: status, groupName }), { message: t('已更新閱讀狀態與分組') })} />
            </div>
            <div className="row-rail">
              <span className={e.serialStatus === 'ongoing' ? 'status status-ongoing' : 'status'}>
                {e.serialStatus ? statusLabel(e.serialStatus) : t('短篇')}
              </span>
            </div>
          </div>
        ))}
      </div>

      {nextCursor && (
        <button className="btn btn-block" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? t('載入中…') : t('載入更多')}
        </button>
      )}

      {note && (
        <Toast
          message={note.message}
          actionLabel={note.undo ? t('復原') : undefined}
          onAction={() => {
            const undo = note.undo;
            setNote(null);
            void undo?.()
              .then(refresh)
              .then(() => refreshUpdates(true))
              .catch(() => {
                void refresh();
                setNote({ message: t('復原失敗，請重新確認狀態') });
              });
          }}
          onDismiss={() => setNote(null)}
        />
      )}
    </div>
  );
}
