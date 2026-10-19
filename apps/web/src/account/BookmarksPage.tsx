// 我的書籤 (§41): newest first, open jumps to the frozen chapter+paragraph (the
// approximation notice comes from the reader), delete in place. Deletion is one
// tap and then undoable, the same bargain 我的書庫 makes for 移出書庫 — the two
// pages were taking the same kind of action and only one of them had a way back.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createBookmark, deleteBookmark, getBookmarks } from '../api/client.ts';
import type { BookmarkEntry } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { readPath, workPath } from '../lib/slug.ts';
import { useMe } from './useMe.ts';
import { MemberNav } from './MemberNav.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { Toast } from '../components/Toast.tsx';
import { dateTime } from '../lib/format.ts';
import { t } from '../i18n/translate.ts';
import { BookmarkNoteEditor } from './BookmarkNoteEditor.tsx';

/** a line of confirmation, optionally with the action that takes it back */
interface Note { message: string; undo?(): Promise<unknown> }

export function BookmarksPage() {
  const { me, loading } = useMe();
  const [entries, setEntries] = useState<BookmarkEntry[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [workId, setWorkId] = useState('');
  const [works, setWorks] = useState<Array<{ id: string; title: string }>>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editorOpener = useRef<HTMLButtonElement | null>(null);
  const generation = useRef(0);
  const retryOffset = useRef(0);
  const [note, setNote] = useState<Note | null>(null);

  const refresh = useCallback((offset = 0) => {
    const request = ++generation.current;
    retryOffset.current = offset;
    setFailed(false);
    setFetching(true);
    return getBookmarks(workId || undefined, offset).then((response) => {
      if (request !== generation.current) return;
      setEntries((previous) => offset === 0 ? response.bookmarks : [...(previous ?? []), ...response.bookmarks]);
      setWorks(response.works);
      setTotal(response.total);
      setNextOffset(response.nextOffset);
    }).catch(() => { if (request === generation.current) setFailed(true); })
      .finally(() => { if (request === generation.current) setFetching(false); });
  }, [workId]);
  useEffect(() => {
    setEntries(null);
    setEditingId(null);
    if (me) void refresh();
    // Counter invalidation intentionally increments the latest request generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++; };
  }, [me, refresh]);

  // the delete is real, so undo re-creates the bookmark from the row's own
  // anchor (chapter + revision + paragraph) — it lands where it was, not nearby
  const remove = (b: BookmarkEntry) => {
    setBusyId(b.id);
    void deleteBookmark(b.id)
      .then(() => refresh())
      .then(() => setNote({
        message: t('已刪除《{title}》的書籤', { title: b.workTitle }),
        undo: () => createBookmark({
          workId: b.workId, chapterId: b.chapterId, revisionId: b.revisionId,
          paragraphIndex: b.paragraphIndex, note: b.note || undefined,
        }),
      }))
      // a delete that silently failed left the row on screen with no reason why
      .catch(() => setNote({ message: t('這次沒有刪成功，請再試一次') }))
      .finally(() => setBusyId(null));
  };

  if (loading) {
    return (
      <div className="page-head">
        <div className="head-line"><h1>{t('我的書籤')}</h1></div>
        <SkeletonRows count={3} />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="auth-page">
        <EmptyState
          title={t('書籤需要登入')}
          body={t('書籤記住的是某一章的某一段，並鎖在當時的修訂版本上——所以它存在帳號裡，而不是這台裝置上。')}
          action={<button className="btn primary" onClick={() => navigate('/login')}>{t('登入')}</button>}
        />
      </div>
    );
  }

  return (
    <div className="bookmarks-page" data-testid="bookmarks">
      <header className="page-head">
        <div className="head-line">
          <h1>{t('我的書籤')}</h1>
          {entries && <span className="head-note tnum">{t('{n} 則', { n: total })}</span>}
        </div>
        <MemberNav current="bookmarks" onError={(message) => setNote({ message })} />
      </header>

      <div className="field">
        <label htmlFor="bookmark-work">{t('按作品篩選')}</label>
        <select id="bookmark-work" className="input" value={workId} onChange={(event) => {
          generation.current++;
          setWorkId(event.target.value);
        }}>
          <option value="">{t('全部作品')}</option>
          {works.map((work) => <option key={work.id} value={work.id}>{work.title}</option>)}
        </select>
      </div>

      {entries === null && !failed && <SkeletonRows count={3} label={t('載入書籤')} />}

      {failed && (
        <EmptyState
          title={t('書籤暫時載不出來')}
          body={t('書籤存在帳號裡，沒有遺失——只是這次沒取到。重試一次通常就好。')}
          action={<button className="btn" onClick={() => void refresh(retryOffset.current)}>{t('重試')}</button>}
        />
      )}

      {!failed && entries !== null && entries.length === 0 && (
        <EmptyState
          title={workId ? t('這部作品目前沒有書籤') : t('還沒有書籤')}
          body={t('閱讀時點一下正文叫出工具列，按「書籤」就會記下目前這一段。章節之後被修訂也找得回來——書籤會落在最接近的段落。')}
          action={<button className="btn" onClick={() => navigate('/me/library')}>{t('回我的書庫')}</button>}
        />
      )}

      <div className="rows">
        {entries?.map((b) => (
          <div key={b.id} className="row" data-testid="bookmark-card">
            <div className="row-main">
              {/* the title is a link here as it is on every other list; it was
                  the one place where tapping a work's name did nothing */}
              <button className="row-title" onClick={() => navigate(workPath({ id: b.workId, title: b.workTitle }))}>
                {b.workTitle}
              </button>
              <div className="row-sub">
                <span className="row-meta">
                  {b.chapterLabel || t('（無標籤）')}　·　{t('第 {n} 段', { n: b.paragraphIndex + 1 })}
                </span>
                {b.note && <span className="row-desc">{b.note}</span>}
                <span className="row-meta">{dateTime(b.createdAt)}</span>
                <span className="row-actions">
                  <button className="chip primary"
                    onClick={() => navigate(`${readPath({ id: b.workId, title: b.workTitle }, { id: b.chapterId })}#p=${b.paragraphIndex}&rev=${b.revisionId}`)}>
                    {t('開啟')}
                  </button>
                  <button className="chip" disabled={busyId === b.id} onClick={(event) => { editorOpener.current = event.currentTarget; setEditingId(b.id); }}>
                    {t('編輯備註')}
                  </button>
                  <button className="chip" disabled={busyId === b.id} onClick={() => remove(b)}>
                    {t('刪除')}
                  </button>
                </span>
              </div>
              {editingId === b.id && <BookmarkNoteEditor key={b.id} bookmarkId={b.id} initialNote={b.note}
                onCancel={() => { setEditingId(null); editorOpener.current?.focus(); }} onSaved={(saved) => {
                  setEntries((previous) => previous?.map((entry) => entry.id === b.id ? { ...entry, note: saved } : entry) ?? null);
                  setEditingId(null);
                  editorOpener.current?.focus();
                  setNote({ message: t('已儲存書籤備註') });
                }} />}
            </div>
          </div>
        ))}
      </div>

      {nextOffset !== null && entries !== null && <button className="btn" disabled={fetching}
        onClick={() => void refresh(nextOffset)}>
        {fetching ? t('載入中…') : t('載入更多（{loaded} / {total}）', { loaded: entries.length, total })}
      </button>}

      {note && (
        <Toast
          message={note.message}
          actionLabel={note.undo ? t('復原') : undefined}
          onAction={() => {
            const undo = note.undo;
            setNote(null);
            void undo?.()
              .then(() => refresh())
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
