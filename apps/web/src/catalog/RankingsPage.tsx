import { useEffect, useState } from 'react';
import { getRankings, getPublicTaxonomy } from '../api/client.ts';
import type { RankingPeriod, RankingResponse, RankingType, RankingFilters } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { count, STATUS_LABEL, TYPE_LABEL } from '../lib/format.ts';

const PERIODS = [{ value: 'week', label: '周榜' }, { value: 'month', label: '月榜' }, { value: 'year', label: '年榜' }, { value: 'all', label: '總榜' }] as const;
function periodFromUrl(): RankingPeriod {
  const value = new URLSearchParams(location.search).get('period');
  return value === 'month' || value === 'year' || value === 'all' ? value : 'week';
}

function typeFromUrl(): RankingType {
  return new URLSearchParams(location.search).get('type') === 'favorites' ? 'favorites' : 'clicks';
}

function filtersFromUrl(): RankingFilters {
  const params = new URLSearchParams(location.search);
  const status = params.get('serialStatus');
  return { serialStatus: status === 'ongoing' || status === 'completed' || status === 'paused' ? status : undefined,
    categoryId: params.get('categoryId') || undefined };
}

export function RankingsPage() {
  const [filters, setFilters] = useState(filtersFromUrl);
  const [categories, setCategories] = useState<Array<{ id: string; displayName: string }>>([]);
  const [taxonomyFailed, setTaxonomyFailed] = useState(false);
  const loadCategories = () => {
    setTaxonomyFailed(false);
    void getPublicTaxonomy('categories').then((r) => setCategories(r.items)).catch(() => setTaxonomyFailed(true));
  };
  useEffect(loadCategories, []);
  const [type, setType] = useState(typeFromUrl);
  const [period, setPeriod] = useState(periodFromUrl);
  const [data, setData] = useState<RankingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const onPop = () => { setPeriod(periodFromUrl()); setType(typeFromUrl()); setFilters(filtersFromUrl()); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setFailed(false); setData(null);
    getRankings(period, type, filters).then((result) => { if (active) setData(result); })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [period, type, filters, retry]);
  function updateUrl(nextType: RankingType, nextPeriod: RankingPeriod, nextFilters: RankingFilters) {
    const params = new URLSearchParams({ type: nextType, period: nextPeriod });
    if (nextFilters.serialStatus) params.set('serialStatus', nextFilters.serialStatus);
    if (nextFilters.categoryId) params.set('categoryId', nextFilters.categoryId);
    history.replaceState(null, '', `/rankings?${params}`);
  }
  function selectFilter(patch: RankingFilters) {
    const next = { ...filters, ...patch };
    setFilters(next); updateUrl(type, period, next);
  }
  function selectPeriod(value: RankingPeriod) {
    setPeriod(value);
    updateUrl(type, value, filters);
  }
  function selectType(value: RankingType) {
    setType(value);
    updateUrl(value, period, filters);
  }
  const label = type === 'favorites' ? '收藏' : '點擊';
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 365;

  // App renders every shell page inside <main class="app-main">; a second one
  // here nested the landmark and doubled the gutter, so this page sat 16px
  // further in than every other page in the app.
  return <div className="rankings-page" data-testid="rankings">
    <header className="page-head">
      <div className="head-line">
        <h1>排行榜</h1>
        <span className="head-note tnum">
          {loading ? '載入中' : data ? `${count(data.works.length)} 部` : ''}
        </span>
      </div>
      <div className="seg" role="group" aria-label="排行類型">
        {([{ value: 'clicks', label: '點擊榜' }, { value: 'favorites', label: '收藏榜' }] as const).map((item) =>
          <button className="seg-item" key={item.value} aria-pressed={type === item.value}
            onClick={() => selectType(item.value)}>{item.label}</button>)}
      </div>
      <div className="seg" role="group" aria-label="排行期間">
        {PERIODS.map((item) => <button className="seg-item" key={item.value}
          id={`rank-tab-${item.value}`} aria-controls="rank-panel"
          aria-pressed={period === item.value} onClick={() => selectPeriod(item.value)}>{item.label}</button>)}
      </div>
      <div className="ranking-filters">
        <label className="field">連載狀態
          <select className="input" value={filters.serialStatus ?? ''} onChange={(e) => selectFilter({ serialStatus: e.target.value as RankingFilters['serialStatus'] || undefined })}>
            <option value="">全部狀態</option><option value="ongoing">連載中</option><option value="completed">已完結</option><option value="paused">暫停</option>
          </select>
        </label>
        <label className="field">分類
          <select className="input" value={filters.categoryId ?? ''} onChange={(e) => selectFilter({ categoryId: e.target.value || undefined })}>
            <option value="">全部分類</option>
            {categories.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
      </div>
      {taxonomyFailed && <p className="form-error" role="alert">分類載入失敗。<button className="linkish" onClick={loadCategories}>重試分類</button></p>}
      <p className="head-note">
        {period === 'all' ? '累計總榜' : `最近 ${days} 日（含今日，台北時間）`} · 最多 50 部 · {type === 'favorites' ? '期間內加入且仍保留的收藏' : '同一裝置同一作品每日計一次'}
      </p>
    </header>

    <div id="rank-panel" aria-busy={loading}>
      {loading && <SkeletonRows count={5} label="載入排行榜" />}

      {failed && (
        <EmptyState
          title="排行榜暫時載不出來"
          body="無法取得排行資料，請稍後重試。"
          action={<button className="btn" onClick={() => setRetry((value) => value + 1)}>重試</button>}
        />
      )}

      {!loading && !failed && data?.works.length === 0 && (
        <EmptyState
          title={`這段期間尚未有${label}紀錄`}
          body={type === 'favorites' ? '讀者收藏公開作品後，這裡就會有名次。' : '點擊統計從功能啟用後開始累積。讀者開啟公開作品頁後，這裡就會有名次。'}
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
              <span className="row-rail"><span className="row-count">{count(type === 'favorites' ? work.favorites : work.clicks)}</span><span>{label}</span></span>
            </button>
          </li>)}
        </ol>
      )}
    </div>
  </div>;
}
