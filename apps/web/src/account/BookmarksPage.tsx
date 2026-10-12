// 我的書籤 (§41): newest first, open jumps to the frozen chapter+paragraph (the
// approximation notice comes from the reader), delete in place. Deletion is one
// tap and then undoable, the same bargain 我的書庫 makes for 移出書庫 — the two
// pages were taking the same kind of action and only one of them had a way back.
import { useCallback, useEffect, useState } from 'react';
import { createBookmark, deleteBookmark, getBookmarks } from '../api/client.ts';
import type { BookmarkEntry } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { useMe } from './useMe.ts';
import { MemberNav } from './MemberNav.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { Toast } from '../components/Toast.tsx';
import { dateTime } from '../lib/format.ts';

/** a line of confirmation, optionally with the action that takes it back */
interface Note { message: string; undo?(): Promise<unknown> }

export function BookmarksPage() {
  const { me, loading } = useMe();
  const [entries, setEntries] = useState<BookmarkEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const refresh = useCallback(() => {
    setFailed(false);
    // "還沒有書籤" after a failed fetch would tell a member their bookmarks
    // are gone; the two states get different copy and different actions
    return getBookmarks().then((r) => setEntries(r.bookmarks)).catch(() => setFailed(true));
  }, []);
  useEffect(() => { if (me) void refresh(); }, [me, refresh]);

  // the delete is real, so undo re-creates the bookmark from the row's own
  // anchor (chapter + revision + paragraph) — it lands where it was, not nearby
  const remove = (b: BookmarkEntry) => {
    setBusyId(b.id);
    void deleteBookmark(b.id)
      .then(refresh)
      .then(() => setNote({
        message: `已刪除《${b.workTitle}》的書籤`,
        undo: () => createBookmark({
          workId: b.workId, chapterId: b.chapterId, revisionId: b.revisionId,
          paragraphIndex: b.paragraphIndex, note: b.note || undefined,
        }),
      }))
      // a delete that silently failed left the row on screen with no reason why
      .catch(() => setNote({ message: '這次沒有刪成功，請再試一次' }))
      .finally(() => setBusyId(null));
  };

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
          {entries && <span className="head-note tnum">{entries.length} 則</span>}
        </div>
        <MemberNav current="bookmarks" onError={(message) => setNote({ message })} />
      </header>

      {entries === null && !failed && <SkeletonRows count={3} label="載入書籤" />}

      {failed && (
        <EmptyState
          title="書籤暫時載不出來"
          body="書籤存在帳號裡，沒有遺失——只是這次沒取到。重試一次通常就好。"
          action={<button className="btn" onClick={() => void refresh()}>重試</button>}
        />
      )}

      {!failed && entries !== null && entries.length === 0 && (
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
              {/* the title is a link here as it is on every other list; it was
                  the one place where tapping a work's name did nothing */}
              <button className="row-title" onClick={() => navigate(`/works/${b.workId}`)}>
                {b.workTitle}
              </button>
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
                  <button className="chip" disabled={busyId === b.id} onClick={() => remove(b)}>
                    刪除
                  </button>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {note && (
        <Toast
          message={note.message}
          actionLabel={note.undo ? '復原' : undefined}
          onAction={() => {
            const undo = note.undo;
            setNote(null);
            void undo?.()
              .then(refresh)
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
