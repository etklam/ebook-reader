import { useEffect, useState } from 'react';
import { getRelatedWorks } from '../api/client.ts';
import type { RelatedWork } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { count, statusLabel, typeLabel } from '../lib/format.ts';
import { t } from '../i18n/translate.ts';
import { workPath } from '../lib/slug.ts';

export function RelatedWorks({ workId }: { workId: string }) {
  const [works, setWorks] = useState<RelatedWork[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setWorks(null); setFailed(false);
    void getRelatedWorks(workId).then((result) => { if (active) setWorks(result.works); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [workId, retry]);
  return <section className="detail-related" aria-labelledby="related-head">
    <h2 id="related-head">{t('相似作品')}</h2>
    <p className="hint">{t('依共同標籤、分類排列。')}</p>
    {!works && !failed && <SkeletonRows count={2} label={t('載入相似作品')} />}
    {failed && <p className="form-error" role="alert">{t('相似作品載入失敗。')}<button className="linkish" onClick={() => setRetry((n) => n + 1)}>{t('重試相似作品')}</button></p>}
    {works?.length === 0 && <p className="muted">{t('目前沒有相同分類或標籤的公開作品。')}</p>}
    <div className="rows">{works?.map((work) => <button className="row" key={work.id} onClick={() => navigate(workPath(work))}>
      <span className="row-main"><span className="row-title">{work.title}</span>
        <span className="row-sub"><span>{work.author || t('佚名')}</span>
          <span>{work.serialStatus ? statusLabel(work.serialStatus) : typeLabel(work.workType)} · {t('{n} 章', { n: count(work.chapterCount) })}</span>
        </span>
      </span>
      <span className="row-rail">
        <span>{t('{n} 個共同標籤', { n: work.sharedTags })}</span>
        <span>{t('{n} 個共同分類', { n: work.sharedCategories })}</span>
      </span>
    </button>)}</div>
  </section>;
}
