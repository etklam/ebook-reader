import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { navigate } from '../App.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { dateTime } from '../lib/format.ts';
import { useMe } from './useMe.ts';

interface ReadingStats {
  totals: { chaptersRead: number; worksRead: number; activeSeconds: number };
  recent: Array<{
    workId: string; workTitle: string; chapterId: string; chapterLabel: string;
    firstReadAt: string; lastReadAt: string; chaptersRead: number;
  }>;
  days: Array<{ date: string; firstReadChapters: number; activeSeconds: number }>;
  calendarTimezone: string;
}

const dateLabel = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString('zh-TW', {
  timeZone: 'UTC', month: 'long', day: 'numeric',
});
const duration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (minutes === 0 && seconds > 0) return `${seconds} 秒`;
  return hours ? `${hours} 小時 ${minutes % 60} 分` : `${minutes} 分鐘`;
};

function ActivityCalendar({ stats }: { stats: ReadingStats }) {
  const byDay = new Map(stats.days.map((d) => [d.date, d]));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 363);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const cells: Array<{ date: string; reads: number; seconds: number; intensity: number } | null> =
    Array.from({ length: Math.ceil((end.getTime() - start.getTime()) / 86_400_000) + 1 }, (_, i) => {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + i);
      if (day > end) return null;
      const date = day.toISOString().slice(0, 10);
      const entry = byDay.get(date);
      const reads = entry?.firstReadChapters ?? 0;
      const seconds = entry?.activeSeconds ?? 0;
      return { date, reads, seconds, intensity: reads + Math.floor(seconds / 600) };
    });

  return (
    <section className="reading-stats-calendar" aria-label="最近一年閱讀日曆">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
        {cells.map((cell, i) => cell ? (
          <span key={cell.date} title={`${dateLabel(cell.date)}：首次讀取 ${cell.reads} 章，閱讀 ${duration(cell.seconds)}`}
            aria-label={`${dateLabel(cell.date)}，首次讀取 ${cell.reads} 章，閱讀 ${duration(cell.seconds)}`}
            style={{ aspectRatio: '1', minWidth: 0, borderRadius: 3, border: '1px solid var(--rule)',
              background: cell.intensity ? 'var(--brand-tint)' : 'var(--surface-2)',
              opacity: cell.intensity ? Math.min(1, 0.52 + cell.intensity * 0.09) : 1 }} />
        ) : <span key={`empty-${i}`} aria-hidden="true" />)}
      </div>
      <p className="row-meta">最近一年。方格記錄首次讀取章數與前景閱讀時間，日期以 UTC 計算。</p>
    </section>
  );
}

export function ReadingStatsPage() {
  const { me, loading } = useMe();
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!me) return;
    void api<ReadingStats>('/api/me/reading-stats').then(setStats).catch(() => setFailed(true));
  }, [me]);

  if (loading) return <div className="page-head"><div className="head-line"><h1>閱讀紀錄</h1></div><SkeletonRows count={3} /></div>;
  if (!me) return <div className="auth-page"><EmptyState title="登入後查看閱讀紀錄"
    body="登入後可以查看讀過的章節、閱讀日期和前景閱讀時間。"
    action={<button className="btn primary" onClick={() => navigate('/login')}>登入</button>} /></div>;

  return (
    <div className="library-page" data-testid="reading-stats">
      <header className="page-head">
        <div className="head-line"><h1>閱讀紀錄</h1></div>
        <nav className="subnav" aria-label="會員頁面">
          <button className="linkish" onClick={() => navigate('/me/library')}>我的書庫</button>
          <button className="linkish" onClick={() => navigate('/me/bookmarks')}>我的書籤</button>
        </nav>
      </header>

      {!stats && !failed && <SkeletonRows count={3} label="載入閱讀紀錄" />}
      {failed && <EmptyState title="閱讀紀錄暫時載不出來" body="資料沒有受影響，請重試。"
        action={<button className="btn" onClick={() => { setFailed(false); void api<ReadingStats>('/api/me/reading-stats').then(setStats).catch(() => setFailed(true)); }}>重試</button>} />}

      {stats && <>
        <section aria-label="閱讀統計" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-6)', padding: 'var(--sp-4) 0' }}>
          <div><strong>{stats.totals.worksRead}</strong><div className="row-meta">讀過作品</div></div>
          <div><strong>{stats.totals.chaptersRead}</strong><div className="row-meta">讀過章節</div></div>
          <div><strong>{duration(stats.totals.activeSeconds)}</strong><div className="row-meta">累積閱讀時間</div></div>
        </section>

        <h2>最近一年</h2>
        <ActivityCalendar stats={stats} />

        <h2 style={{ marginTop: 'var(--sp-8)' }}>最近讀過</h2>
        {stats.recent.length === 0 ? <p className="row-meta">還沒有閱讀紀錄。開啟一章後會出現在這裡。</p> : (
          <div className="rows">
            {stats.recent.map((entry) => (
              <div className="row" key={entry.chapterId}>
                <div className="row-main">
                  <button className="row-title" onClick={() => navigate(`/read/${entry.workId}/${entry.chapterId}`)}>{entry.workTitle}</button>
                  <div className="row-sub"><span className="row-meta">{entry.chapterLabel || '（無章名）'}</span>
                    <span className="row-meta">已讀 {entry.chaptersRead} 章</span>
                    <span className="row-meta">最近閱讀 {dateTime(entry.lastReadAt)}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="row-meta">章節數是曾開啟過的不同章節；閱讀日曆記錄首次開啟日期。閱讀時間只計頁面在前景且近期有操作的時段。</p>
      </>}
    </div>
  );
}
