// Work detail (§23): a colophon page — title, author, then the facts on a
// tabular baseline, TOC (windowed), and the reachable bottom action bar the
// mobile spec asks for (§04). For signed-in members: favourite/follow with
// update state. Opening the detail marks followed updates seen (§38 policy).
import { useCallback, useEffect, useState } from 'react';
import {
  addToLibrary, follow, getToc, getWorkDetail, getWorkMemberState,
  getProgress, markFollowSeen, removeFromLibrary, unfollow,
} from '../api/client.ts';
import type { ServerProgress, TocEntry, WorkDetail } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { useMe } from '../account/useMe.ts';
import { BottomSheet } from '../reader/BottomSheet.tsx';
import { Icon } from '../components/Icon.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { STATUS_LABEL, TYPE_LABEL_LONG, count, relativeDay } from '../lib/format.ts';

export function WorkDetailPage({ workId }: { workId: string }) {
  const { me } = useMe();
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocTotal, setTocTotal] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [tocLoading, setTocLoading] = useState(false);
  const [progress, setProgress] = useState<ServerProgress | null>(null);
  const [inLibrary, setInLibrary] = useState(false);
  const [following, setFollowing] = useState(false);
  const [updateBadge, setUpdateBadge] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getWorkDetail(workId).then((w) => {
      if (cancelled) return;
      setWork(w);
      // opening the detail marks followed updates seen (§38)
      if (me) void markFollowSeen(workId).catch(() => undefined);
    }).catch((e: { code?: string }) => {
      if (!cancelled) setError(e.code ?? 'work_not_found');
    });
    return () => { cancelled = true; };
  }, [workId]);

  useEffect(() => {
    if (!tocOpen) return;
    setTocLoading(true);
    void getToc(workId, 200, 0)
      .then((r) => { setToc(r.chapters); setTocTotal(r.total); })
      .finally(() => setTocLoading(false));
  }, [tocOpen, workId]);

  useEffect(() => {
    if (!me) return;
    void getProgress(workId).then((r) => setProgress(r.progress)).catch(() => undefined);
  }, [me, workId]);

  // one request for this work's state: the library is keyset-paginated, so
  // scanning page 1 would report "not saved" for anything further down
  const refreshState = useCallback(() => {
    if (!me) return;
    void getWorkMemberState(workId)
      .then((s) => {
        setInLibrary(s.inLibrary);
        setFollowing(s.following);
        setUpdateBadge(s.newChapterCount);
      }).catch(() => undefined);
  }, [me, workId]);
  useEffect(() => { refreshState(); }, [refreshState]);

  const act = (p: Promise<unknown>) => {
    setBusy(true);
    void p.then(refreshState).catch(() => undefined).finally(() => setBusy(false));
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
    return (
      <div className="work-detail" role="status" aria-label="載入作品">
        <div style={{ paddingTop: 'var(--sp-7)' }}>
          <div className="sk sk-line" style={{ width: '62%', height: '1.6em' }} aria-hidden="true" />
          <div className="sk sk-line" style={{ width: '28%' }} aria-hidden="true" />
          <div style={{ marginTop: 'var(--sp-6)' }} aria-hidden="true">
            {['40%', '55%', '48%', '60%'].map((w, i) => (
              <div className="sk sk-line" key={i} style={{ width: w, height: '1em', margin: '14px 0' }} />
            ))}
          </div>
        </div>
      </div>
    );
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

      {!me && (
        <p className="head-note" style={{ marginTop: 'var(--sp-6)' }}>
          未登入也能閱讀；<button className="linkish" onClick={() => navigate('/login')}>登入</button>
          後可收藏、追更，並跨裝置同步進度。
        </p>
      )}

      <div className="detail-cta">
        <button className="btn primary" onClick={startReading} disabled={!work.firstChapterId && !progress}>
          {progress ? '繼續閱讀' : '開始閱讀'}
        </button>
        <button className="btn" onClick={() => setTocOpen(true)}>目錄</button>
      </div>

      <BottomSheet open={tocOpen} title={`目錄（${count(tocTotal)} 章）`} onClose={() => setTocOpen(false)}>
        {tocLoading && toc.length === 0 && (
          <div role="status" aria-label="載入目錄">
            {Array.from({ length: 8 }, (_, i) => (
              <div className="sk sk-line" key={i} style={{ height: '1.1em', margin: '18px 0' }} aria-hidden="true" />
            ))}
          </div>
        )}
        <ol className="toc-list">
          {toc.map((c) => (
            <li key={c.id}>
              <button className="toc-item" onClick={() => { setTocOpen(false); navigate(`/read/${workId}/${c.id}`); }}>
                <span className="toc-label">{c.labelRaw || '（無標籤）'}</span>
                {c.title && <span className="toc-title">{c.title}</span>}
              </button>
            </li>
          ))}
        </ol>
        {toc.length < tocTotal && (
          <button className="btn toc-more" onClick={() => getToc(workId, 200, toc.length).then((r) => { setToc((prev) => [...prev, ...r.chapters]); })}>
            載入更多（{toc.length} / {tocTotal}）
          </button>
        )}
      </BottomSheet>
    </div>
  );
}
