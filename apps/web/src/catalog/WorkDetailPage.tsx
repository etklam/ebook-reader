// Work detail (§23): metadata, TOC (windowed), read/continue, and — for
// signed-in members — favorite/follow with update state. Opening the detail
// marks followed updates seen (§38 policy).
import { useCallback, useEffect, useState } from 'react';
import {
  addToLibrary, follow, getFollows, getLibrary, getToc, getWorkDetail,
  getProgress, markFollowSeen, removeFromLibrary, unfollow,
} from '../api/client.ts';
import type { ServerProgress, TocEntry, WorkDetail } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { useMe } from '../account/useMe.ts';
import { BottomSheet } from '../reader/BottomSheet.tsx';

export function WorkDetailPage({ workId }: { workId: string }) {
  const { me } = useMe();
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocTotal, setTocTotal] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [progress, setProgress] = useState<ServerProgress | null>(null);
  const [inLibrary, setInLibrary] = useState(false);
  const [following, setFollowing] = useState(false);
  const [updateBadge, setUpdateBadge] = useState(0);

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
    if (tocOpen) {
      void getToc(workId, 200, 0).then((r) => { setToc(r.chapters); setTocTotal(r.total); });
    }
  }, [tocOpen, workId]);

  useEffect(() => {
    if (!me) return;
    void getProgress(workId).then((r) => setProgress(r.progress)).catch(() => undefined);
  }, [me, workId]);

  const refreshState = useCallback(() => {
    if (!me) return;
    void Promise.all([getLibrary(), getFollows()])
      .then(([lib, fol]) => {
        setInLibrary(lib.works.some((w) => w.workId === workId));
        const f = fol.follows.find((x) => x.workId === workId);
        setFollowing(Boolean(f));
        setUpdateBadge(f?.newChapterCount ?? 0);
      }).catch(() => undefined);
  }, [me, workId]);
  useEffect(() => { refreshState(); }, [refreshState]);

  if (error) {
    return (
      <div className="reader-msg">
        <p>{error === 'work_not_found' ? '找不到這部作品' : '載入失敗'}</p>
        <button className="reader-btn" onClick={() => navigate('/')}>回書庫</button>
      </div>
    );
  }
  if (!work) return <p className="muted page-pad">載入中…</p>;

  const startReading = () => {
    const target = progress?.chapterId ?? work.firstChapterId;
    if (target) navigate(`/read/${workId}/${target}`);
  };
  const TYPE_LABEL = { serial: '長篇連載', short_story: '短篇小說' } as const;
  const STATUS_LABEL = { ongoing: '連載中', completed: '已完結', paused: '暫停' } as const;

  return (
    <div className="work-detail" data-testid="work-detail">
      <header className="detail-head">
        <button className="reader-btn" aria-label="回書庫" onClick={() => navigate('/')}>←</button>
        <div className="detail-actions">
          {me && (
            <>
              <button
                className={`reader-btn chip${inLibrary ? ' active selected' : ''}`}
                aria-pressed={inLibrary}
                onClick={() => (inLibrary ? removeFromLibrary(workId) : addToLibrary(workId))
                  .then(refreshState).catch(() => undefined)}
              >
                {inLibrary ? '★ 已收藏' : '☆ 收藏'}
              </button>
              <button
                className={`reader-btn chip${following ? ' active selected' : ''}`}
                aria-pressed={following}
                onClick={() => (following ? unfollow(workId) : follow(workId))
                  .then(refreshState).catch(() => undefined)}
              >
                {following ? `✓ 追更${updateBadge > 0 ? `（${updateBadge} 新章）` : ''}` : '追更'}
              </button>
            </>
          )}
        </div>
      </header>

      <h1>{work.title}</h1>
      <p className="work-author">{work.author || '佚名'}</p>
      <p className="work-meta">
        {TYPE_LABEL[work.workType]}
        {work.serialStatus ? ` · ${STATUS_LABEL[work.serialStatus]}` : ''}
        {` · 已發布 ${work.chapterCount} 章`}
        {` · 最近發布 ${new Date(work.publishedAt).toLocaleDateString('zh-Hant')}`}
      </p>
      {work.categories.length > 0 && <p className="work-meta">分類：{work.categories.join('、')}</p>}
      {work.tags.length > 0 && <p className="work-tags">{work.tags.map((t) => `#${t}`).join('  ')}</p>}
      {work.description && <p className="work-desc-full">{work.description}</p>}

      <div className="detail-cta">
        <button className="reader-btn primary" onClick={startReading}>
          {progress ? '繼續閱讀' : '開始閱讀'}
        </button>
        <button className="reader-btn" onClick={() => setTocOpen(true)}>目錄</button>
      </div>

      <BottomSheet open={tocOpen} title={`目錄（${tocTotal} 章）`} onClose={() => setTocOpen(false)}>
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
          <button className="reader-btn toc-more" onClick={() => getToc(workId, 200, toc.length).then((r) => { setToc((prev) => [...prev, ...r.chapters]); })}>
            載入更多（{toc.length} / {tocTotal}）
          </button>
        )}
      </BottomSheet>
    </div>
  );
}
