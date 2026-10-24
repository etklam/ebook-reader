// Work detail (§23): a colophon page — title, author, then the facts on a
// tabular baseline, the newest chapters in reach, the full TOC (windowed), and
// the reachable bottom action bar the mobile spec asks for (§04). For signed-in
// members: favourite/follow with update state. Opening the detail marks
// followed updates seen (§38 policy).
import { RelatedWorks } from './RelatedWorks.tsx';
import { useCallback, useEffect, useState } from 'react';
import {
  addToLibrary, follow, getToc, getWorkDetail, getWorkMemberState,
  getProgress, recordWorkClick, markFollowSeen, removeFromLibrary, unfollow,
} from '../api/client.ts';
import type { ServerProgress, TocEntry, WorkDetail } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { readPath, samePath, workPath } from '../lib/slug.ts';
import { absoluteUrl, applyHead, describe } from '../lib/head.ts';
import { useMe } from '../account/useMe.ts';
import { refreshUpdates } from '../account/useUpdates.ts';
import { BottomSheet } from '../reader/BottomSheet.tsx';
import { TableOfContents } from '../reader/TableOfContents.tsx';
import { Icon } from '../components/Icon.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { SkeletonDetail, SkeletonLines } from '../components/Skeleton.tsx';
import { statusLabel, typeLabelLong, count, relativeDay } from '../lib/format.ts';
import { t } from '../i18n/translate.ts';
import { useLocale } from '../i18n/I18nRoot.tsx';
import { currentLocale } from '../i18n/translate.ts';

/** chapters shown inline; the rest stay one tap away in the TOC sheet */
const LATEST = 5;

/**
 * `workRef` is the URL's own segment — `<slug>-<publicId>` or a legacy uuid.
 * Read-only public endpoints take it as-is (the server resolves either form);
 * every member endpoint is keyed by the work's uuid, which is only known once
 * the detail response lands, so those are gated on `workId` below.
 */
export function WorkDetailPage({ workRef }: { workRef: string }) {
  const { me } = useMe();
  const { locale } = useLocale();
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

  // the uuid behind the URL's ref; null until the work has loaded
  const workId = work?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    getWorkDetail(workRef).then((w) => {
      if (!cancelled) { setWork(w); void recordWorkClick(w.id).catch(() => undefined); }
    }).catch((e: { code?: string }) => {
      if (!cancelled) setError(e.code ?? 'work_not_found');
    });
    return () => { cancelled = true; };
  }, [workRef]);

  // Canonical URL + head, once the title is known. The address bar is
  // rewritten rather than pushed: arriving from a stale slug or a legacy uuid
  // link should not cost the reader a back-button press to leave the page.
  // A work that did not load has no title to canonicalize and must not keep
  // the previous route's head: without this, a dead link renders "找不到這部
  // 作品" under another book's title, description and canonical URL.
  useEffect(() => {
    if (!error) return;
    applyHead({ page: t('找不到這部作品'), noindex: true });
  }, [error, locale]);

  useEffect(() => {
    if (!work) return;
    const canonical = workPath(work);
    if (!samePath(location.pathname, canonical)) {
      history.replaceState(null, '', encodeURI(canonical) + location.search);
    }
    const description = describe(work.description, t('{type}，已發布 {n} 章', { type: typeLabelLong(work.workType), n: work.chapterCount }));
    const indexable = work.visibility === 'public';
    applyHead({
      page: `${work.title}${work.author ? ` - ${work.author}` : ''}`,
      description,
      canonicalPath: canonical,
      ogType: 'book',
      // unlisted means reachable by direct URL but never listed; indexing it
      // would be the listing it was promised to be exempt from
      noindex: !indexable,
      // No structured data for a work that must not be listed: a Book node is
      // an invitation to index it.
      jsonLd: indexable ? {
        '@context': 'https://schema.org',
        '@type': 'Book',
        name: work.title,
        url: absoluteUrl(canonical),
        inLanguage: currentLocale(),
        ...(work.author ? { author: { '@type': 'Person', name: work.author } } : {}),
        ...(work.description ? { description: work.description } : {}),
        numberOfPages: work.chapterCount,
      } : undefined,
    });
    // `locale` is a real dependency: the title and description are translated
  }, [work, locale]);

  // The newest chapters are the tail of the editorial order, and the published
  // chapter count is already in hand — so the window is one request, not a
  // count request followed by a page request.
  const loadLatest = useCallback((total: number) => {
    setLatestFailed(false);
    const tail = (n: number) => getToc(workRef, LATEST, Math.max(0, n - LATEST));
    return tail(total)
      // counts can disagree if a release landed between the two reads
      .then((r) => (r.chapters.length === 0 && r.total > 0 ? tail(r.total) : r))
      .then((r) => setLatest([...r.chapters].reverse()))
      .catch(() => setLatestFailed(true));
  }, [workRef]);

  useEffect(() => {
    if (work) void loadLatest(work.chapterCount);
  }, [work, loadLatest]);

  useEffect(() => {
    if (!me || !workId) return;
    void getProgress(workId).then((r) => setProgress(r.progress)).catch(() => undefined);
  }, [me, workId]);

  // one request for this work's state: the library is keyset-paginated, so
  // scanning page 1 would report "not saved" for anything further down
  const refreshState = useCallback(() => {
    if (!me || !workId) return Promise.resolve();
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
    if (!me || !workId) return;
    void markFollowSeen(workId).then(() => refreshUpdates(true)).then(refreshState).catch(() => undefined);
  }, [me, workId, refreshState]);

  const act = (p: Promise<unknown>) => {
    setBusy(true);
    void p.then(refreshState).then(() => refreshUpdates(true)).catch(() => undefined).finally(() => setBusy(false));
  };

  if (error) {
    return (
      <EmptyState
        title={error === 'work_not_found' ? t('找不到這部作品') : t('載入失敗')}
        body={error === 'work_not_found'
          ? t('它可能尚未發布，或連結已經失效。書庫只顯示已發布的版本。')
          : t('連線出了狀況。回書庫再試一次通常就好。')}
        action={<button className="btn" onClick={() => navigate('/')}>{t('回書庫')}</button>}
      />
    );
  }

  if (!work) {
    return <div className="work-detail"><SkeletonDetail /></div>;
  }

  const startReading = () => {
    // a resumed position or the first published chapter, by uuid: the reader
    // canonicalizes the path once it knows the chapter's label
    const target = progress?.chapterId ?? work.firstChapterId;
    if (target) navigate(readPath(work, { id: target }));
  };

  return (
    <div className="work-detail" data-testid="work-detail">
      <header className="detail-head">
        <button className="icon-btn" aria-label={t('回書庫')} onClick={() => navigate('/')}>
          <Icon name="back" />
        </button>
        <div className="detail-actions">
          {me && (
            <>
              <button
                className={`chip${inLibrary ? ' selected' : ''}`}
                aria-pressed={inLibrary}
                disabled={busy}
                onClick={() => act(inLibrary ? removeFromLibrary(work.id) : addToLibrary(work.id))}
              >
                {inLibrary ? `★ ${t('已收藏')}` : `☆ ${t('收藏')}`}
              </button>
              <button
                className={`chip${following ? ' selected' : ''}`}
                aria-pressed={following}
                disabled={busy}
                onClick={() => act(following ? unfollow(work.id) : follow(work.id))}
              >
                {following
                  ? `✓ ${updateBadge > 0 ? t('追更（{n} 新章）', { n: updateBadge }) : t('追更')}`
                  : t('追更')}
              </button>
            </>
          )}
        </div>
      </header>

      <h1 className="detail-title">{work.title}</h1>
      <p className="detail-author">{work.author || t('佚名')}</p>

      <dl className="detail-colophon meta-grid">
        <dt>{t('類型')}</dt>
        <dd>
          {typeLabelLong(work.workType)}
          {work.serialStatus ? ` · ${statusLabel(work.serialStatus)}` : ''}
        </dd>
        <dt>{t('已發布')}</dt>
        <dd>{t('{n} 章', { n: count(work.chapterCount) })}</dd>
        <dt>{t('最近發布')}</dt>
        <dd>
          {relativeDay(work.publishedAt)}
          {work.releaseVersion ? <span className="muted">　{t('版本 v{v}', { v: work.releaseVersion })}</span> : null}
        </dd>
        {work.categories.length > 0 && (
          <>
            <dt>{t('分類')}</dt>
            <dd>{work.categories.join('、')}</dd>
          </>
        )}
        {work.tags.length > 0 && (
          <>
            <dt>{t('標籤')}</dt>
            <dd>{work.tags.map((tag) => `#${tag}`).join('　')}</dd>
          </>
        )}
      </dl>

      {work.description && <p className="detail-desc">{work.description}</p>}

      {/* the sign-in offer belongs with the work's facts, above the chapter
          list — under it, it is the last line of a long page */}
      {!me && (
        <p className="head-note detail-note">
          {t('未登入也能閱讀；')}<button className="linkish" onClick={() => navigate('/login')}>{t('登入')}</button>
          {t('後可收藏、追更，並跨裝置同步進度。')}
        </p>
      )}

      {/* The newest chapters are the reason a follower opens this page, so they
          are on it — not behind the sheet. The sheet still holds all 1,284. */}
      <section className="detail-chapters" aria-labelledby="latest-head">
        <div className="head-line">
          <h2 id="latest-head">{t('最新章節')}</h2>
          <button className="linkish" onClick={() => setTocOpen(true)}>
            {t('全部 {n} 章', { n: count(work.chapterCount) })}
          </button>
        </div>
        {latest === null && !latestFailed && <SkeletonLines count={3} label={t('載入最新章節')} />}
        {latestFailed && (
          <p className="muted">
            {t('章節列表暫時載不出來。')}{' '}
            <button className="linkish" onClick={() => void loadLatest(work.chapterCount)}>{t('重試')}</button>
          </p>
        )}
        {latest?.length === 0 && <p className="muted">{t('這個版本還沒有章節。')}</p>}
        <ol className="toc-list">
          {latest?.map((c) => (
            <li key={c.id}>
              <button className="toc-item" onClick={() => navigate(readPath(work, c))}>
                <span className="toc-label">{c.labelRaw || t('（無標籤）')}</span>
                {c.title && <span className="toc-title">{c.title}</span>}
              </button>
            </li>
          ))}
        </ol>
      </section>

      <RelatedWorks workId={workRef} />

      <div className="detail-cta">
        <button className="btn primary" onClick={startReading} disabled={!work.firstChapterId && !progress}>
          {progress ? t('繼續閱讀') : t('開始閱讀')}
        </button>
        <button className="btn" onClick={() => setTocOpen(true)}>{t('目錄')}</button>
      </div>

      {/* one TOC implementation for the whole site: the reader's. It windows,
          survives a failed page, and keeps irregular labels verbatim. */}
      <BottomSheet open={tocOpen} title={t('目錄（{n} 章）', { n: count(work.chapterCount) })} onClose={() => setTocOpen(false)}>
        <TableOfContents
          workId={workRef}
          onJump={(_id, entry) => { setTocOpen(false); navigate(readPath(work, entry)); }}
        />
      </BottomSheet>
    </div>
  );
}
