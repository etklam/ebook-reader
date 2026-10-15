import { useEffect, useState } from 'react';
import { api, ApiRequestError } from '../api/client.ts';

type Version = { id: string; label: string; kind: 'head' | 'release'; active?: boolean };
type VersionsResponse = { work: { id: string; title: string }; versions: Version[] };

function downloadName(header: string | null, fallback: string): string {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* use fallback */ }
  }
  return fallback;
}

export function ExportPanel({ workId, refresh = 0 }: { workId: string; refresh?: number }) {
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [version, setVersion] = useState('');
  const [format, setFormat] = useState<'txt' | 'epub'>('epub');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    setData(null); setVersion(''); setMessage('');
    if (!workId) return () => { active = false; };
    api<VersionsResponse>(`/api/admin/works/${workId}/export-versions`)
      .then((result) => {
        if (!active) return;
        setData(result);
        setVersion(result.versions.find((item) => item.active)?.id ?? 'head');
      })
      .catch((error) => { if (active) setMessage(error instanceof ApiRequestError && [401, 403].includes(error.status)
        ? '管理員登入已失效或權限不足，請重新登入管理後台。' : '無法載入可匯出的版本，請確認網絡後重新選擇作品。'); });
    return () => { active = false; };
  }, [workId, refresh]);

  const exportBook = async () => {
    if (!version || busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/admin/works/${workId}/export?format=${format}&version=${encodeURIComponent(version)}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new ApiRequestError(response.status, body.error ?? 'export_failed', body);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName(response.headers.get('content-disposition'), `${data?.work.title ?? 'ebook'}.${format}`);
      document.body.append(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setMessage(`已下載 ${data?.work.title ?? '作品'}（${data?.versions.find((item) => item.id === version)?.label ?? version}）。`);
    } catch (error) {
      const code = error instanceof ApiRequestError ? error.code : '';
      setMessage(error instanceof ApiRequestError && [401, 403].includes(error.status)
        ? '管理員登入已失效或權限不足，請重新登入管理後台。'
        : code === 'content_unavailable'
          ? '這個版本的章節或圖片檔案缺失，無法完整匯出。請先檢查並修復儲存檔案，或選擇其他完整版本。'
          : code === 'no_chapters' ? '這個版本沒有可匯出的章節，請選擇其他版本。'
            : code === 'version_not_found' ? '所選版本已不存在，請重新選擇作品以載入版本清單。'
              : '匯出失敗，請確認網絡後重試。');
    } finally { setBusy(false); }
  };

  return (
    <section className="admin-panel" aria-label="匯出作品">
      <h2>匯出作品</h2>
      <p className="muted">選擇明確版本後下載 TXT 或 EPUB。EPUB 會包含章節目錄及作品圖片。</p>
      {!workId && <p className="hint">請先選擇作品。</p>}
      {workId && !data && !message && <p className="hint" role="status">載入版本中…</p>}
      {data && <>
        <p className="hint">{data.work.title}</p>
        <div className="field">
          <label htmlFor="export-version">作品版本</label>
          <select className="input" id="export-version" value={version} onChange={(event) => setVersion(event.target.value)}>
            {data.versions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="export-format">檔案格式</label>
          <select className="input" id="export-format" value={format}
            onChange={(event) => setFormat(event.target.value as 'txt' | 'epub')}>
            <option value="epub">EPUB（含目錄及圖片）</option>
            <option value="txt">純文字 TXT</option>
          </select>
        </div>
        <button className="btn primary btn-block" disabled={!version || busy} onClick={() => void exportBook()}>
          {busy ? '準備下載…' : '下載所選版本'}
        </button>
      </>}
      {message && <p className="hint" role="status">{message}</p>}
    </section>
  );
}
