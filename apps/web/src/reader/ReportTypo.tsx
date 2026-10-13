import { useState } from 'react';
import { api, ApiRequestError } from '../api/client.ts';
import type { ReaderChapter } from '../api/types.ts';
import { navigate } from '../App.tsx';

export function ReportTypo({ chapter, paragraphIndex, isMember }: {
  chapter: ReaderChapter; paragraphIndex: number; isMember: boolean;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [target, setTarget] = useState(String(paragraphIndex + 1));
  const paragraphs = chapter.body === '' ? [] : chapter.body.split('\n\n');
  const targetIndex = Number(target) - 1;
  const validTarget = target.trim() !== '' && Number.isSafeInteger(targetIndex) && targetIndex >= 0 && targetIndex < paragraphs.length;
  const paragraph = validTarget ? paragraphs[targetIndex] : undefined;
  if (!isMember) return <div><p>登入後可回報章節錯字。</p><button className="btn primary" onClick={() => navigate('/login')}>登入</button></div>;
  if (sent) return <p role="status">已送出回報，謝謝你的協助。</p>;
  return <form className="typo-report" onSubmit={(e) => {
    e.preventDefault();
    if (busy || !message.trim() || !validTarget) return;
    setBusy(true); setError('');
    void api('/api/me/content-reports', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workId: chapter.workId, chapterId: chapter.chapterId,
        revisionId: chapter.revisionId, paragraphIndex: targetIndex, message }) })
      .then(() => setSent(true))
      .catch((err: unknown) => setError(err instanceof ApiRequestError && err.status === 429
        ? '回報次數已達上限，請一小時後再試。'
        : err instanceof ApiRequestError && err.code === 'report_location_unavailable'
          ? '章節版本已更新，請重新載入章節後回報。' : '回報未能送出，請稍後再試。'))
      .finally(() => setBusy(false));
  }}>
    <p className="hint">{chapter.labelRaw} {chapter.title}</p>
    <div className="field"><label htmlFor="typo-paragraph">回報段落</label>
      <input className="input" id="typo-paragraph" type="number" min={1} max={paragraphs.length} step={1}
        required disabled={busy} value={target} onChange={(e) => setTarget(e.target.value)} />
    </div>
    {paragraph === undefined ? <p role="alert">請選擇 1 至 {paragraphs.length} 段。</p> : <blockquote>{paragraph.slice(0, 1000)}</blockquote>}
    <div className="field"><label htmlFor="typo-message">錯字或建議修正</label>
      <textarea className="input" id="typo-message" rows={4} required maxLength={1000}
        disabled={busy} value={message} onChange={(e) => setMessage(e.target.value)} />
    </div>
    {error && <p role="alert">{error}</p>}
    <button className="btn primary" disabled={busy || !message.trim() || !validTarget}>{busy ? '送出中…' : '送出回報'}</button>
  </form>;
}
