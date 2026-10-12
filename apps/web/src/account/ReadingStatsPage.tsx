// 閱讀紀錄: totals, a year of reading activity, and the chapters most recently
// opened. The calendar is the one chart on the site, so it follows the same
// rules as the rest: tabular figures, a stated scale, and no meaning carried by
// colour alone (dev-plan §21).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { navigate } from '../App.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { count, dateTime } from '../lib/format.ts';
import { MemberNav } from './MemberNav.tsx';
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

const DAY_MS = 86_400_000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const dateLabel = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString('zh-TW', {
  timeZone: 'UTC', month: 'long', day: 'numeric',
});
const duration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (minutes === 0 && seconds > 0) return `${seconds} 秒`;
  return hours ? `${hours} 小時 ${minutes % 60} 分` : `${minutes} 分鐘`;
};

/** 0 = nothing recorded, then four steps. Thresholds are weight, not raw reads:
 *  one chapter and ten minutes are both a day someone read. */
function heat(reads: number, seconds: number): 0 | 1 | 2 | 3 | 4 {
  const weight = reads + Math.floor(seconds / 600);
  if (weight <= 0) return 0;
  if (weight <= 2) return 1;
  if (weight <= 5) return 2;
  if (weight <= 9) return 3;
  return 4;
}

interface Cell { date: string; reads: number; seconds: number; level: 0 | 1 | 2 | 3 | 4 }

function buildCells(days: ReadingStats['days']): Array<Cell | null> {
  const byDay = new Map(days.map((d) => [d.date, d]));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 363);
  // the grid reads down the week, so it has to begin on a Sunday
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const total = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  // pad to a whole week so the last column is a column, not a stub
  const padded = total + ((7 - (total % 7)) % 7);
  return Array.from({ length: padded }, (_, i) => {
    if (i >= total) return null;
    const day = new Date(start.getTime() + i * DAY_MS);
    const date = day.toISOString().slice(0, 10);
    const entry = byDay.get(date);
    const reads = entry?.firstReadChapters ?? 0;
    const seconds = entry?.activeSeconds ?? 0;
    return { date, reads, seconds, level: heat(reads, seconds) };
  });
}

function ActivityCalendar({ days }: { days: ReadingStats['days'] }) {
  const cells = buildCells(days);
  const scroller = useRef<HTMLDivElement>(null);
  // a year is wider than any phone; the end of it is the part worth seeing
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  const activeDays = cells.filter((c) => c && c.level > 0).length;
  const weeks = cells.length / 7;

  // one label per month, spanning the weeks whose Sunday falls inside it
  const months: Array<{ key: string; label: string; span: number }> = [];
  for (let w = 0; w < weeks; w += 1) {
    const first = cells[w * 7];
    if (!first) { if (months.length) months[months.length - 1].span += 1; continue; }
    const month = first.date.slice(0, 7);
    const last = months[months.length - 1];
    if (last && last.key === month) last.span += 1;
    else months.push({ key: month, label: `${Number(first.date.slice(5, 7))} 月`, span: 1 });
  }
  // a one-week sliver has no room for its label; fold it into the month before
  for (let i = months.length - 1; i > 0; i -= 1) {
    if (months[i].span < 3) { months[i - 1].span += months[i].span; months.splice(i, 1); }
  }

  return (
    <section className="reading-stats-calendar" aria-labelledby="cal-head">
      <div className="sec-head">
        <h2 id="cal-head">最近一年</h2>
        <span className="head-note tnum">{count(activeDays)} 天有紀錄</span>
      </div>
      <div className="cal-wrap">
        <div className="cal-gutter" aria-hidden="true">
          {WEEKDAYS.map((d, i) => <span key={d}>{i % 2 === 1 ? d : ''}</span>)}
        </div>
        <div
          className="cal"
          ref={scroller}
          tabIndex={0}
          role="img"
          aria-label={`最近一年的閱讀日曆，共 ${activeDays} 天有閱讀紀錄。逐日數字列在下方的「最近讀過」。`}
        >
          <div className="cal-months" aria-hidden="true">
            {months.map((m) => <span key={m.key} style={{ gridColumn: `span ${m.span}` }}>{m.label}</span>)}
          </div>
          <div className="cal-grid" aria-hidden="true">
            {cells.map((cell, i) => (cell
              ? <span
                  key={cell.date}
                  className="cal-cell"
                  data-heat={cell.level}
                  title={`${dateLabel(cell.date)}：首次讀取 ${cell.reads} 章，閱讀 ${duration(cell.seconds)}`}
                />
              : <span key={`pad-${i}`} />))}
          </div>
        </div>
      </div>
      <p className="cal-legend">
        <span>少</span>
        <span className="cal-swatches" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((n) => <span key={n} className="cal-cell" data-heat={n} />)}
        </span>
        <span>多</span>
        <span className="cal-legend-end">一格一天，顏色越深讀得越多</span>
      </p>
    </section>
  );
}

export function ReadingStatsPage() {
  const { me, loading } = useMe();
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    return api<ReadingStats>('/api/me/reading-stats').then(setStats).catch(() => setFailed(true));
  }, []);
  useEffect(() => { if (me) void load(); }, [me, load]);

  if (loading) {
    return (
      <div className="page-head">
        <div className="head-line"><h1>閱讀紀錄</h1></div>
        <SkeletonRows count={3} />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="auth-page">
        <EmptyState
          title="登入後查看閱讀紀錄"
          body="讀過哪些章、哪幾天在讀、累積讀了多久——都記在帳號裡，換一台裝置也還在。"
          action={<button className="btn primary" onClick={() => navigate('/login')}>登入</button>}
        />
      </div>
    );
  }

  return (
    <div className="reading-stats-page" data-testid="reading-stats">
      <header className="page-head">
        <div className="head-line"><h1>閱讀紀錄</h1></div>
        <MemberNav current="reading-stats" />
      </header>

      {!stats && !failed && <SkeletonRows count={3} label="載入閱讀紀錄" />}

      {failed && (
        <EmptyState
          title="閱讀紀錄暫時載不出來"
          body="紀錄存在帳號裡，沒有受影響——只是這次沒取到。重試一次通常就好。"
          action={<button className="btn" onClick={() => void load()}>重試</button>}
        />
      )}

      {stats && <>
        {/* .tally is the shared figure-over-label rhythm the admin tallies use */}
        <div className="tally stats-totals" role="group" aria-label="閱讀統計">
          <div><b>{count(stats.totals.worksRead)}</b>讀過作品</div>
          <div><b>{count(stats.totals.chaptersRead)}</b>讀過章節</div>
          <div><b>{duration(stats.totals.activeSeconds)}</b>累積閱讀時間</div>
        </div>

        <ActivityCalendar days={stats.days} />

        <div className="sec-head"><h2 id="recent-head">最近讀過</h2></div>
        {stats.recent.length === 0 ? (
          <p className="muted">還沒有閱讀紀錄。開啟一章後會出現在這裡。</p>
        ) : (
          <div className="rows" aria-labelledby="recent-head">
            {stats.recent.map((entry) => (
              <div className="row" key={entry.chapterId}>
                <div className="row-main">
                  <button
                    className="row-title"
                    onClick={() => navigate(`/read/${entry.workId}/${entry.chapterId}`)}
                  >
                    {entry.workTitle}
                  </button>
                  <div className="row-sub">
                    <span className="row-meta">{entry.chapterLabel || '（無章名）'}</span>
                    <span className="row-meta">最近閱讀 {dateTime(entry.lastReadAt)}</span>
                  </div>
                </div>
                <div className="row-rail">
                  <span className="row-count tnum">{count(entry.chaptersRead)} 章</span>
                  <span>已讀</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="hint page-pad">
          章節數算的是曾經開啟過的不同章節；日曆記的是首次開啟的日期。閱讀時間只計頁面在前景、且近期有操作的時段，
          日期以 UTC 計算。
        </p>
      </>}
    </div>
  );
}
