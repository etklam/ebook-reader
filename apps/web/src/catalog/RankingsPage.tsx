import { useEffect, useState } from 'react';
import { getRankings } from '../api/client.ts';
import type { RankingPeriod, RankingResponse } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
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
  return <main className="app-main rankings-page">
    <header className="page-head">
      <div className="head-line"><h1>點擊排行榜</h1><button className="linkish" onClick={() => navigate('/')}>回書庫</button></div>
      <div className="seg" role="tablist" aria-label="排行期間">
        {PERIODS.map((item) => <button className="seg-item" role="tab" key={item.value}
          aria-selected={period === item.value} onClick={() => selectPeriod(item.value)}>{item.label}</button>)}
      </div>
      <p className="head-note">最近 {period === 'week' ? 7 : period === 'month' ? 30 : 365} 日（含今日，台北時間） · 最多 50 部</p>
      <p className="hint">按作品頁點擊排行，同一裝置同一作品每日計一次；統計由功能啟用後開始。</p>
    </header>
    {loading && <SkeletonRows count={5} label="載入排行榜" />}
    {failed && <div className="empty" role="alert"><h2>排行榜暫時無法載入</h2>
      <button className="btn" onClick={() => setRetry((value) => value + 1)}>重試</button></div>}
    {!loading && !failed && data && (data.works.length ? <ol className="ranking-list">
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
    </ol> : <div className="empty"><h2>這段期間尚未有點擊紀錄</h2>
      <p>讀者開啟公開作品頁後，排行榜就會開始累積。</p><button className="btn" onClick={() => navigate('/')}>到書庫看看</button></div>)}
  </main>;
}
