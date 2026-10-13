import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';

type Report = {
  id: string; workId: string; chapterId: string; revisionId: string;
  paragraphIndex: number; excerpt: string; message: string;
  status: 'open' | 'resolved'; createdAt: string; resolvedAt: string | null;
  workTitle: string; chapterTitle: string;
};

export function ContentReportsPanel({ onEdit }: {
  onEdit(workId: string, chapterId: string, paragraphIndex: number): void;
}) {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [offset, setOffset] = useState(0);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setReports([]);
    void api<{ reports: Report[] }>(`/api/admin/content-reports?status=${status}&offset=${offset}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setReports(data.reports); })
      .catch(() => { if (!controller.signal.aborted) setError('無法載入錯字回報。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [status, offset, refresh]);
  const resolve = async (id: string) => {
    setBusyId(id); setError('');
    try {
      await api(`/api/admin/content-reports/${id}`, { method: 'PATCH',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) });
      if (reports.length === 1 && offset > 0) setOffset(offset - 50);
      else setRefresh((n) => n + 1);
    } catch { setError('未能標記已處理，請再試。'); }
    finally { setBusyId(''); }
  };
  return <section className="content-reports-panel">
    <h2>章節錯字回報</h2>
    <div className="field"><label htmlFor="report-status">處理狀態</label>
      <select className="input" id="report-status" value={status} disabled={!!busyId} onChange={(e) => {
        setStatus(e.target.value as 'open' | 'resolved'); setOffset(0);
      }}><option value="open">待處理</option><option value="resolved">已處理</option></select>
    </div>
    {error && <p role="alert">{error} <button className="btn" onClick={() => setRefresh((n) => n + 1)}>重試</button></p>}
    {loading ? <p role="status">載入中…</p> : !error && reports.length === 0 ? <p>暫無{status === 'open' ? '待處理' : '已處理'}回報。</p> : null}
    {reports.map((report) => <article className="content-report" key={report.id}>
      <h3>{report.workTitle} · {report.chapterTitle || '章節'}</h3>
      <p className="hint">第 {report.paragraphIndex + 1} 段 · {new Date(report.createdAt).toLocaleString('zh-TW')}</p>
      <blockquote>{report.excerpt}</blockquote><p>{report.message}</p>
      <p className="hint">此摘錄保留回報時的版本。編輯前請核對目前章節內容。</p>
      <div className="msg-actions">
        <button className="btn" onClick={() => onEdit(report.workId, report.chapterId, report.paragraphIndex)}>前往章節編輯</button>
        {status === 'open' && <button className="btn primary" disabled={!!busyId}
          onClick={() => void resolve(report.id)}>{busyId === report.id ? '處理中…' : '標記已處理'}</button>}
      </div>
    </article>)}
    <div className="msg-actions">
      <button className="btn" disabled={loading || !!busyId || offset === 0} onClick={() => setOffset(offset - 50)}>上一頁</button>
      <button className="btn" disabled={loading || !!busyId || reports.length < 50} onClick={() => setOffset(offset + 50)}>下一頁</button>
    </div>
  </section>;
}
