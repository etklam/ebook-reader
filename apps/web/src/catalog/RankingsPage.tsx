import { useEffect, useState } from 'react';
import { getRankings } from '../api/client.ts';
import type { RankingPeriod, RankingResponse } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { count, STATUS_LABEL, TYPE_LABEL } from '../lib/format.ts';

const PERIODS = [{ value: 'week', label: '周榜' }, { value: 'month', label: '月榜' }, { value: 'year', label: '年榜' }] as const;
function periodFromUrl(): RankingPeriod {
  const value = new URLSearchParams(location.search).get('period');
  return value === 'month' || value === 'year' ? value : 'week';
}

export function RankingsPage() {
  const [period, setPeriod] = useState(periodFromUrl);
  const [data, setData] = useState<RankingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const onPop = () => setPeriod(periodFromUrl());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setFailed(false); setData(null);
    getRankings(period).then((result) => { if (active) setData(result); })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [period, retry]);
  function selectPeriod(value: RankingPeriod) {
    setPeriod(value);
    history.replaceState(null, '', `/rankings?period=${value}`);
  }
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 365;

  // App renders every shell page inside <main class="app-main">; a second one
  // here nested the landmark and doubled the gutter, so this page sat 16px
  // further in than every other page in the app.
  return <div className="rankings-page" data-testid="rankings">
    <header className="page-head">
      <div className="head-line">
        <h1>點擊排行榜</h1>
        <span className="head-note tnum">
          {loading ? '載入中' : data ? `${count(data.works.length)} 部` : ''}
        </span>
      </div>
      <div className="seg" role="tablist" aria-label="排行期間">
        {PERIODS.map((item) => <button className="seg-item" role="tab" key={item.value}
          id={`rank-tab-${item.value}`} aria-controls="rank-panel"
          aria-selected={period === item.value} onClick={() => selectPeriod(item.value)}>{item.label}</button>)}
      </div>
      {/* one line of apparatus, not two: period, cap and counting rule */}
      <p className="head-note">
        最近 {days} 日（含今日，台北時間）· 最多 50 部 · 同一裝置同一作品每日計一次
      </p>
    </header>

    <div id="rank-panel" role="tabpanel" aria-labelledby={`rank-tab-${period}`}>
      {loading && <SkeletonRows count={5} label="載入排行榜" />}

      {failed && (
        <EmptyState
          title="排行榜暫時載不出來"
          body="排行是從點擊紀錄即時算出來的，沒有遺失——只是這次沒取到。重試一次通常就好。"
          action={<button className="btn" onClick={() => setRetry((value) => value + 1)}>重試</button>}
        />
      )}

      {!loading && !failed && data?.works.length === 0 && (
        <EmptyState
          title="這段期間尚未有點擊紀錄"
          body="排行統計是從功能啟用後開始累積的。讀者開啟公開作品頁之後，這裡就會有名次。"
          action={<button className="btn" onClick={() => navigate('/')}>到書庫看看</button>}
        />
      )}

      {!loading && !failed && data && data.works.length > 0 && (
        <ol className="ranking-list">
          {data.works.map((work, index) => <li key={work.id}>
            <button className="row ranking-row" onClick={() => navigate(`/works/${work.id}`)}>
              <span className="ranking-position" aria-label={`第 ${index + 1} 名`}>{index + 1}</span>
              <span className="row-main"><span className="row-title">{work.title}</span>
                <span className="row-sub"><span className="row-author">{work.author || '佚名'}</span>
                  <span>{work.serialStatus ? STATUS_LABEL[work.serialStatus] : TYPE_LABEL[work.workType]} · {count(work.chapterCount)} 章</span>
                </span></span>
              <span className="row-rail"><span className="row-count">{count(work.clicks)}</span><span>點擊</span></span>
            </button>
          </li>)}
        </ol>
      )}
    </div>
  </div>;
}
