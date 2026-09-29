// M2 Admin import screen — the minimum UI to exercise the import vertical
// slice (upload → poll → preview → commit). The public website/reader is M5/M6.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// --- tiny API helpers ----------------------------------------------------------
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const STATUS_TEXT: Record<string, string> = {
  queued: '排隊中', processing: '解析中', review_required: '需要人工覆核',
  ready: '可提交', failed: '失敗', cancelled: '已取消', committed: '已提交', applied: '已套用增量',
};

// --- app ------------------------------------------------------------------------
function App() {
  const [me, setMe] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  useEffect(() => {
    api('/api/me').then(({ body }) => setMe(body.user));
  }, []);

  if (me === null) return <p style={s.loading}>載入中…</p>;

  if (!me) {
    return (
      <main style={s.page}>
        <h1 style={s.h1}>管理員登入</h1>
        {loginError && <p style={s.error}>{loginError}</p>}
        <form style={s.form} onSubmit={async (e) => {
          e.preventDefault();
          const { status: st } = await api('/api/auth/login', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          if (st !== 200) { setLoginError('登入失敗'); return; }
          const me2 = await api('/api/me');
          setMe(me2.body.user);
        }}>
          <input style={s.input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input style={s.input} type="password" placeholder="密碼" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button style={s.button} type="submit">登入</button>
        </form>
      </main>
    );
  }

  if (me.role !== 'admin') {
    return (
      <main style={s.page}>
        <p>此帳號不是管理員。</p>
        <button style={s.button} onClick={async () => { await api('/api/auth/logout', { method: 'POST' }); setMe(null); }}>登出</button>
      </main>
    );
  }

  return (
    <main style={s.page}>
      <h1 style={s.h1}>匯入管理（M2）</h1>
      <p style={s.muted}>已登入：{email || 'admin'}</p>
      <ImportPanel />
    </main>
  );
}

type Job = {
  id: string; status: string; workId: string | null; detected_encoding: string | null;
  detectedEncoding?: string | null; chapter_count: number | null;
  encodingResult: any; errorCode: string | null; errorDetail: string | null;
  stagedChapters: number; stagedNeedsReview: number; sourceFile: any;
};

function ImportPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [workType, setWorkType] = useState('serial');
  const [encoding, setEncoding] = useState('');
  const [workId, setWorkId] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [diff, setDiff] = useState<any>(null);
  const [applyResult, setApplyResult] = useState<any>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [commitResult, setCommitResult] = useState<any>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function poll(id: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const { status, body } = await api(`/api/admin/imports/${id}`);
      if (status !== 200) return;
      setJob(body);
      if (!['queued', 'processing'].includes(body.status) && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 1500);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setError(''); setCommitResult(null); setJob(null); setDiff(null); setApplyResult(null);
    const form = new FormData();
    form.append('file', file);
    if (title) form.append('title', title); // display hint only; real title goes to commit
    if (encoding) form.append('encoding', encoding);
    if (workId) form.append('workId', workId);
    const { status, body } = await api('/api/admin/imports', { method: 'POST', body: form });
    setBusy(false);
    if (status !== 201) { setError(body.error ?? '上傳失敗'); return; }
    setImportId(body.importId);
    poll(body.importId);
  }

  async function reanalyze(enc = '') {
    if (!importId) return;
    setBusy(true);
    const { status, body } = await api(`/api/admin/imports/${importId}/reanalyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(enc ? { encoding: enc } : {}),
    });
    setBusy(false);
    if (status !== 200) { setError(body.error ?? '重新解析失敗'); return; }
    setJob((j) => j && { ...j, status: 'queued' });
    poll(importId);
  }

  async function commit() {
    if (!importId) return;
    setBusy(true); setError('');
    const { status, body } = await api(`/api/admin/imports/${importId}/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title || '未命名作品', workType }),
    });
    setBusy(false);
    if (status !== 200) { setError(`${body.error ?? 'commit 失敗'}${body.detail ? `：${body.detail}` : ''}`); return; }
    setCommitResult(body);
    const refreshed = await api(`/api/admin/imports/${importId}`);
    if (refreshed.status === 200) setJob(refreshed.body);
  }

  async function loadDiff() {
    if (!importId) return;
    setBusy(true); setError('');
    const { status, body } = await api(`/api/admin/imports/${importId}/diff`);
    setBusy(false);
    if (status !== 200) { setError(body.error ?? '比對失敗'); return; }
    setDiff(body);
  }

  async function applyIncremental(confirmAppend = false) {
    if (!importId || !diff) return;
    setBusy(true); setError('');
    const { status, body } = await api(`/api/admin/imports/${importId}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseEditVersion: diff.editVersion, confirmAppend }),
    });
    setBusy(false);
    if (status !== 200) { setError(`${body.error ?? '套用失敗'}${body.unresolved?.length ? `（${body.unresolved.length} 項待決：${body.unresolved.map((u: any) => u.labelRaw).join('、')}）` : ''}`); return; }
    setApplyResult(body);
    const refreshed = await api(`/api/admin/imports/${importId}`);
    if (refreshed.status === 200) setJob(refreshed.body);
  }

  const enc = job?.encodingResult;
  const detected = job?.detectedEncoding ?? job?.detected_encoding;

  return (
    <>
      <form style={s.form} onSubmit={submit}>
        <label style={s.label}>TXT／EPUB 檔案（TXT 上限 30 MiB、EPUB 50 MiB）</label>
        <input style={s.input} type="file" accept=".txt,.epub" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        <label style={s.label}>作品名稱（提交時建立）</label>
        <input style={s.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：長夜將盡" />
        <label style={s.label}>作品類型</label>
        <select style={s.input} value={workType} onChange={(e) => setWorkType(e.target.value)}>
          <option value="serial">長篇連載</option>
          <option value="short_story">短篇小說</option>
        </select>
        <label style={s.label}>目標作品 ID（增量匯入時填；留空＝新作品）</label>
        <input style={s.input} value={workId} onChange={(e) => setWorkId(e.target.value)} placeholder="work UUID" />
        <label style={s.label}>指定編碼（可留空自動偵測）</label>
        <select style={s.input} value={encoding} onChange={(e) => setEncoding(e.target.value)}>
          <option value="">自動偵測</option>
          <option value="utf-8">UTF-8</option>
          <option value="utf-16le">UTF-16 LE</option>
          <option value="utf-16be">UTF-16 BE</option>
          <option value="big5">Big5</option>
          <option value="gb18030">GB18030</option>
        </select>
        <button style={s.button} type="submit" disabled={busy || !file}>上傳並解析</button>
      </form>

      {error && <p style={s.error}>{error}</p>}

      {job && (
        <section style={s.card}>
          <h2 style={s.h2}>匯入狀態：{STATUS_TEXT[job.status] ?? job.status}</h2>
          {job.sourceFile && (
            <p style={s.muted}>來源：{job.sourceFile.mimeType} · {job.sourceFile.sizeBytes} bytes · sha256 {String(job.sourceFile.fileHash).slice(0, 12)}…</p>
          )}
          {detected && (
            <p>編碼：<b>{detected}</b>（{enc?.confidence}）{enc?.reason ? ` — ${enc.reason}` : ''}</p>
          )}
          {enc?.warnings?.length > 0 && (
            <ul style={s.warnList}>{enc.warnings.map((w: string, i: number) => <li key={i} style={s.warn}>⚠ {w}</li>)}</ul>
          )}
          {job.status === 'failed' && (
            <p style={s.error}>失敗：{job.errorCode}{job.errorDetail ? ` — ${job.errorDetail}` : ''}
              <button style={{ ...s.button, marginLeft: 8 }} onClick={() => reanalyze()} disabled={busy}>重新解析</button>
            </p>
          )}
          {(job.status === 'ready' || job.status === 'review_required' || job.status === 'applied') && job.workId && (
            <>
              <button style={s.button} onClick={loadDiff} disabled={busy}>與現有章節比對</button>
              {diff && (
                <div style={{ marginTop: 8 }}>
                  <p>相同 <b>{diff.match.items.filter((i: any) => i.itemClass === 'unchanged').length}</b>｜
                     有修訂（增量保留站方）<b>{diff.match.items.filter((i: any) => i.itemClass === 'modified').length}</b>｜
                     新章 <b>{diff.match.items.filter((i: any) => i.itemClass === 'new').length}</b>｜
                     待決 <b>{diff.match.items.filter((i: any) => ['ambiguous', 'structural_conflict'].includes(i.itemClass)).length}</b>｜
                     來源缺失（保留）<b>{diff.match.missingFromSource.length}</b></p>
                  <p style={s.muted}>基準版本 edit_version = {diff.editVersion}</p>
                  {diff.match.needsReview && <p style={s.warn}>有項目需要決策（待決清單會顯示在套用錯誤訊息）；無錨點的新章可用「確認全部追加到結尾」。</p>}
                  <button style={s.button} onClick={() => applyIncremental()} disabled={busy || job.status === 'applied'}>
                    套用增量
                  </button>{' '}
                  <button style={s.button} onClick={() => applyIncremental(true)} disabled={busy || job.status === 'applied'}>
                    確認全部追加到結尾
                  </button>
                </div>
              )}
              {applyResult && (
                <p style={s.ok}>已套用（增量）：新增 {applyResult.summary.added}、相同 {applyResult.summary.unchanged}、
                  保留站方修訂 {applyResult.summary.modifiedKept}、略過 {applyResult.summary.skipped}、
                  保留缺失 {applyResult.summary.missingKept}；edit_version → {applyResult.newEditVersion}。</p>
              )}
            </>
          )}
          {(job.status === 'ready' || job.status === 'review_required') && (
            <>
              <p>偵測章節數：<b>{job.stagedChapters}</b>{job.stagedNeedsReview > 0 && <span style={s.warn}>（{job.stagedNeedsReview} 章需要覆核）</span>}</p>
              <ChapterList importId={importId!} />
              {!job.workId && (
                <button style={s.button} onClick={commit} disabled={busy}>
                  {job.status === 'review_required' ? '覆核後提交為草稿' : '提交為草稿'}
                </button>
              )}
            </>
          )}
          {job.status === 'committed' && commitResult && (
            <p style={s.ok}>已提交：作品 {commitResult.workId}，共 {commitResult.chapterCount} 章（草稿，未公開）。</p>
          )}
        </section>
      )}
    </>
  );
}

function ChapterList({ importId }: { importId: string }) {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setData(null);
    api(`/api/admin/imports/${importId}/chapters?page=${page}&limit=50`).then(({ body }) => setData(body));
  }, [importId, page]);

  if (!data) return <p style={s.muted}>載入章節…</p>;
  const pages = Math.ceil(data.total / data.limit);
  return (
    <div>
      <ol style={s.list}>
        {data.chapters.map((c: any) => (
          <li key={c.position} style={s.item}>
            <b>{c.labelRaw || '（無標籤）'}</b>{c.title ? ` ${c.title}` : ''}
            {c.needsReview && <span style={s.warn}>（需覆核）</span>}
            <br /><span style={s.muted}>{c.snippet}…</span>
            {c.warnings?.length > 0 && <div style={s.warn}>{c.warnings.join('、')}</div>}
          </li>
        ))}
      </ol>
      <p style={s.muted}>
        第 {data.page} / {pages} 頁
        <button style={{ ...s.button, marginLeft: 8 }} disabled={page <= 1} onClick={() => setPage(page - 1)}>上一頁</button>
        <button style={{ ...s.button, marginLeft: 8 }} disabled={page >= pages} onClick={() => setPage(page + 1)}>下一頁</button>
      </p>
    </div>
  );
}

// --- minimal mobile-reasonable styles -------------------------------------------
const s = {
  page: { fontFamily: 'sans-serif', maxWidth: 640, margin: '0 auto', padding: 16, paddingBottom: 64 },
  loading: { fontFamily: 'sans-serif', padding: 24 },
  h1: { fontSize: 20 },
  h2: { fontSize: 16 },
  form: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 },
  label: { fontSize: 13, color: '#555' },
  input: { padding: '10px 12px', fontSize: 16, borderRadius: 6, border: '1px solid #ccc' },
  button: { padding: '10px 16px', fontSize: 15, borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' },
  card: { border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 16 },
  list: { paddingLeft: 20, margin: '8px 0' },
  item: { marginBottom: 8, fontSize: 14 },
  muted: { color: '#777', fontSize: 13 },
  error: { color: '#b91c1c' },
  ok: { color: '#15803d' },
  warn: { color: '#b45309', fontSize: 13 },
  warnList: { paddingLeft: 20, margin: '4px 0', color: '#b45309', fontSize: 13 },
} as const;

createRoot(document.getElementById('root')!).render(<App />);
