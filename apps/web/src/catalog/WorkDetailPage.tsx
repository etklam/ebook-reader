// Work detail (§23): a colophon page — title, author, then the facts on a
// tabular baseline, the newest chapters in reach, the full TOC (windowed), and
// the reachable bottom action bar the mobile spec asks for (§04). For signed-in
// members: favourite/follow with update state. Opening the detail marks
// followed updates seen (§38 policy).
import { useCallback, useEffect, useState } from 'react';
import {
  addToLibrary, follow, getToc, getWorkDetail, getWorkMemberState,
  getProgress, markFollowSeen, removeFromLibrary, unfollow,
} from '../api/client.ts';
import type { ServerProgress, TocEntry, WorkDetail } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { useMe } from '../account/useMe.ts';
import { refreshUpdates } from '../account/useUpdates.ts';
import { BottomSheet } from '../reader/BottomSheet.tsx';
import { TableOfContents } from '../reader/TableOfContents.tsx';
import { Icon } from '../components/Icon.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { SkeletonDetail, SkeletonLines } from '../components/Skeleton.tsx';
import { STATUS_LABEL, TYPE_LABEL_LONG, count, relativeDay } from '../lib/format.ts';

/** chapters shown inline; the rest stay one tap away in the TOC sheet */
const LATEST = 5;

export function WorkDetailPage({ workId }: { workId: string }) {
  const { me } = useMe();
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<TocEntry[] | null>(null);
  const [latestFailed, setLatestFailed] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [progress, setProgress] = useState<ServerProgress | null>(null);
  const [inLibrary, setInLibrary] = useState(false);
  const [following, setFollowing] = useState(false);
  const [updateBadge, setUpdateBadge] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getWorkDetail(workId).then((w) => {
      if (!cancelled) setWork(w);
    }).catch((e: { code?: string }) => {
      if (!cancelled) setError(e.code ?? 'work_not_found');
    });
    return () => { cancelled = true; };
  }, [workId]);

  // The newest chapters are the tail of the editorial order, and the published
  // chapter count is already in hand — so the window is one request, not a
  // count request followed by a page request.
  const loadLatest = useCallback((total: number) => {
    setLatestFailed(false);
    const tail = (n: number) => getToc(workId, LATEST, Math.max(0, n - LATEST));
    return tail(total)
      // counts can disagree if a release landed between the two reads
      .then((r) => (r.chapters.length === 0 && r.total > 0 ? tail(r.total) : r))
      .then((r) => setLatest([...r.chapters].reverse()))
      .catch(() => setLatestFailed(true));
  }, [workId]);

  useEffect(() => {
    if (work) void loadLatest(work.chapterCount);
  }, [work, loadLatest]);

  useEffect(() => {
    if (!me) return;
    void getProgress(workId).then((r) => setProgress(r.progress)).catch(() => undefined);
  }, [me, workId]);

  // one request for this work's state: the library is keyset-paginated, so
  // scanning page 1 would report "not saved" for anything further down
  const refreshState = useCallback(() => {
    if (!me) return Promise.resolve();
    return getWorkMemberState(workId)
      .then((s) => {
        setInLibrary(s.inLibrary);
        setFollowing(s.following);
        setUpdateBadge(s.newChapterCount);
      }).then(() => undefined).catch(() => undefined);
  }, [me, workId]);
  useEffect(() => { refreshState(); }, [refreshState]);

  // Mark seen after the session is known, then refresh both the global badge
  // and this page's follow count so neither races the write.
  useEffect(() => {
    if (!me) return;
    void markFollowSeen(workId).then(() => refreshUpdates(true)).then(refreshState).catch(() => undefined);
  }, [me, workId, refreshState]);

  const act = (p: Promise<unknown>) => {
    setBusy(true);
    void p.then(refreshState).then(() => refreshUpdates(true)).catch(() => undefined).finally(() => setBusy(false));
  };

  if (error) {
    return (
      <EmptyState
        title={error === 'work_not_found' ? '找不到這部作品' : '載入失敗'}
        body={error === 'work_not_found'
          ? '它可能尚未發布，或連結已經失效。書庫只顯示已發布的版本。'
          : '連線出了狀況。回書庫再試一次通常就好。'}
        action={<button className="btn" onClick={() => navigate('/')}>回書庫</button>}
      />
    );
  }

  if (!work) {
    return <div className="work-detail"><SkeletonDetail /></div>;
  }

  const startReading = () => {
    const target = progress?.chapterId ?? work.firstChapterId;
    if (target) navigate(`/read/${workId}/${target}`);
  };

  return (
    <div className="work-detail" data-testid="work-detail">
      <header className="detail-head">
        <button className="icon-btn" aria-label="回書庫" onClick={() => navigate('/')}>
          <Icon name="back" />
        </button>
        <div className="detail-actions">
          {me && (
            <>
              <button
                className={`chip${inLibrary ? ' selected' : ''}`}
                aria-pressed={inLibrary}
                disabled={busy}
                onClick={() => act(inLibrary ? removeFromLibrary(workId) : addToLibrary(workId))}
              >
                {inLibrary ? '★ 已收藏' : '☆ 收藏'}
              </button>
              <button
                className={`chip${following ? ' selected' : ''}`}
                aria-pressed={following}
                disabled={busy}
                onClick={() => act(following ? unfollow(workId) : follow(workId))}
              >
                {following ? `✓ 追更${updateBadge > 0 ? `（${updateBadge} 新章）` : ''}` : '追更'}
              </button>
            </>
          )}
        </div>
      </header>

      <h1 className="detail-title">{work.title}</h1>
      <p className="detail-author">{work.author || '佚名'}</p>

      <dl className="detail-colophon meta-grid">
        <dt>類型</dt>
        <dd>
          {TYPE_LABEL_LONG[work.workType]}
          {work.serialStatus ? ` · ${STATUS_LABEL[work.serialStatus]}` : ''}
        </dd>
        <dt>已發布</dt>
        <dd>{count(work.chapterCount)} 章</dd>
        <dt>最近發布</dt>
        <dd>
          {relativeDay(work.publishedAt)}
          {work.releaseVersion ? <span className="muted">　版本 v{work.releaseVersion}</span> : null}
        </dd>
        {work.categories.length > 0 && (
          <>
            <dt>分類</dt>
            <dd>{work.categories.join('、')}</dd>
          </>
        )}
        {work.tags.length > 0 && (
          <>
            <dt>標籤</dt>
            <dd>{work.tags.map((t) => `#${t}`).join('　')}</dd>
          </>
        )}
      </dl>

      {work.description && <p className="detail-desc">{work.description}</p>}

      {/* the sign-in offer belongs with the work's facts, above the chapter
          list — under it, it is the last line of a long page */}
      {!me && (
        <p className="head-note detail-note">
          未登入也能閱讀；<button className="linkish" onClick={() => navigate('/login')}>登入</button>
          後可收藏、追更，並跨裝置同步進度。
        </p>
      )}

      {/* The newest chapters are the reason a follower opens this page, so they
          are on it — not behind the sheet. The sheet still holds all 1,284. */}
      <section className="detail-chapters" aria-labelledby="latest-head">
        <div className="head-line">
          <h2 id="latest-head">最新章節</h2>
          <button className="linkish" onClick={() => setTocOpen(true)}>
            全部 {count(work.chapterCount)} 章
          </button>
        </div>
        {latest === null && !latestFailed && <SkeletonLines count={3} label="載入最新章節" />}
        {latestFailed && (
          <p className="muted">
            章節列表暫時載不出來。{' '}
            <button className="linkish" onClick={() => void loadLatest(work.chapterCount)}>重試</button>
          </p>
        )}
        {latest?.length === 0 && <p className="muted">這個版本還沒有章節。</p>}
        <ol className="toc-list">
          {latest?.map((c) => (
            <li key={c.id}>
              <button className="toc-item" onClick={() => navigate(`/read/${workId}/${c.id}`)}>
                <span className="toc-label">{c.labelRaw || '（無標籤）'}</span>
                {c.title && <span className="toc-title">{c.title}</span>}
              </button>
            </li>
          ))}
        </ol>
      </section>

      <div className="detail-cta">
        <button className="btn primary" onClick={startReading} disabled={!work.firstChapterId && !progress}>
          {progress ? '繼續閱讀' : '開始閱讀'}
        </button>
        <button className="btn" onClick={() => setTocOpen(true)}>目錄</button>
      </div>

      {/* one TOC implementation for the whole site: the reader's. It windows,
          survives a failed page, and keeps irregular labels verbatim. */}
      <BottomSheet open={tocOpen} title={`目錄（${count(work.chapterCount)} 章）`} onClose={() => setTocOpen(false)}>
        <TableOfContents
          workId={workId}
          onJump={(id) => { setTocOpen(false); navigate(`/read/${workId}/${id}`); }}
        />
      </BottomSheet>
    </div>
  );
}
