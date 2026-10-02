// Admin: upload → poll → preview → commit → diff/apply/revert (M2–M4) plus
// publish and taxonomy (M6). Same token vocabulary as the member surfaces — the
// person reviewing machine output deserves the same legibility as the reader.
import { useEffect, useRef, useState } from 'react';
import { navigate } from '../App.tsx';
import { PublishPanel } from './PublishPanel.tsx';
import { TaxonomyPanel } from './TaxonomyPanel.tsx';
import { count } from '../lib/format.ts';

// --- tiny API helpers ----------------------------------------------------------
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const STATUS_TEXT: Record<string, string> = {
  queued: '排隊中', processing: '解析中', review_required: '需要人工覆核',
  ready: '可提交', failed: '失敗', cancelled: '已取消', committed: '已提交', applied: '已套用增量',
};

// status drives a dot colour *and* the word — never colour alone
const STATUS_TONE: Record<string, string> = {
  queued: 'state-busy', processing: 'state-busy', review_required: 'state-review',
  ready: 'state-ok', committed: 'state-ok', applied: 'state-ok',
  failed: 'state-bad', cancelled: 'state-bad',
};

function Status({ status }: { status: string }) {
  return (
    <span className={`state ${STATUS_TONE[status] ?? ''}`}>
      {STATUS_TEXT[status] ?? status}
    </span>
  );
}

// --- app ------------------------------------------------------------------------
export function AdminApp() {
  const [me, setMe] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/me').then(({ body }) => setMe(body.user));
  }, []);

  if (me === null) {
    return (
      <div className="app-main admin-shell" role="status" aria-label="載入中">
        <div className="sk sk-line" style={{ width: '40%', height: '1.6em', marginTop: 32 }} />
      </div>
    );
  }

  if (!me) {
    return (
      <main className="app-main admin-shell">
        <div className="auth-page">
          <h1>管理員登入</h1>
          <p className="auth-lede">匯入、發布與分類管理需要管理員帳號。</p>
          <form className="auth-form" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const { status: st } = await api('/api/auth/login', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email, password }),
            });
            setBusy(false);
            if (st !== 200) { setLoginError('登入失敗，請確認帳號與密碼'); return; }
            const me2 = await api('/api/me');
            setMe(me2.body.user);
          }}>
            <div className="field">
              <label htmlFor="admin-email">電子郵件</label>
              <input className="input" id="admin-email" type="email" value={email} required
                autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="admin-password">密碼</label>
              <input className="input" id="admin-password" type="password" value={password} required
                autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
            </div>
            {loginError && <p className="form-error" role="alert">{loginError}</p>}
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? '登入中…' : '登入'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (me.role !== 'admin') {
    return (
      <main className="app-main admin-shell">
        <div className="empty">
          <h2>這個帳號不是管理員</h2>
          <p>管理後台只開放給管理員帳號。可以改用其他帳號登入，或回書庫繼續閱讀。</p>
          <div className="row-actions">
            <button className="btn" onClick={async () => {
              await api('/api/auth/logout', { method: 'POST' });
              setMe(null);
            }}>登出</button>
            <button className="btn" onClick={() => navigate('/')}>回書庫</button>
          </div>
        </div>
      </main>
    );
  }

  return <AdminHome email={me.email || email || 'admin'} onLogout={() => setMe(null)} />;
}

function AdminHome({ email, onLogout }: { email: string; onLogout(): void }) {
  const [tab, setTab] = useState<'import' | 'publish' | 'taxonomy'>('import');
  return (
    <main className="app-main admin-shell">
      <header className="page-head">
        <div className="head-line">
          <h1>管理後台</h1>
          <span className="head-note">
            {email}
            {'　'}
            <button className="linkish" onClick={async () => {
              await api('/api/auth/logout', { method: 'POST' });
              onLogout();
            }}>登出</button>
          </span>
        </div>
        <div className="seg" role="tablist" aria-label="管理功能">
          {([
            ['import', '匯入'],
            ['publish', '發布'],
            ['taxonomy', '分類標籤'],
          ] as const).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={tab === v} className="seg-item"
              onClick={() => setTab(v)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {tab === 'import' && <ImportPanel />}
      {tab === 'publish' && <PublishPanel />}
      {tab === 'taxonomy' && <TaxonomyPanel />}
    </main>
  );
}

type Job = {
  id: string; status: string; workId: string | null; detected_encoding: string | null;
  detectedEncoding?: string | null; chapter_count: number | null;
  encodingResult: any; errorCode: string | null; errorDetail: string | null;
  stagedChapters: number; stagedNeedsReview: number; sourceFile: any;
  committedWorkId: string | null;
};

const ENCODINGS = [
  { v: '', label: '自動偵測' },
  { v: 'utf-8', label: 'UTF-8' },
  { v: 'utf-16le', label: 'UTF-16 LE' },
  { v: 'utf-16be', label: 'UTF-16 BE' },
  { v: 'big5', label: 'Big5' },
  { v: 'gb18030', label: 'GB18030' },
];

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

  async function applyIncremental(mode: 'incremental' | 'overwrite', confirmAppend = false) {
    if (!importId || !diff) return;
    setBusy(true); setError('');
    const key = `ui-${importId}-${mode}-${Date.now()}`;
    const { status, body } = await api(`/api/admin/imports/${importId}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ baseEditVersion: diff.editVersion, mode, confirmAppend }),
    });
    setBusy(false);
    if (status !== 200) { setError(`${body.error ?? '套用失敗'}${body.unresolved?.length ? `（${body.unresolved.length} 項待決：${body.unresolved.map((u: any) => u.labelRaw).join('、')}）` : ''}`); return; }
    setApplyResult(body);
    const refreshed = await api(`/api/admin/imports/${importId}`);
    if (refreshed.status === 200) setJob(refreshed.body);
  }

  async function doRevert() {
    if (!importId || !diff) return;
    setBusy(true); setError('');
    const plan = await api(`/api/admin/imports/${importId}/revert-plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    if (plan.status !== 200 || !plan.body.canRevert) {
      setBusy(false);
      setError(`無法回復：${plan.body?.reason ?? plan.body?.error ?? '未知原因'}`);
      return;
    }
    const { status, body } = await api(`/api/admin/imports/${importId}/revert`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseEditVersion: plan.body.plan.editVersionFrom }),
    });
    setBusy(false);
    if (status !== 200) { setError(body.error ?? '回復失敗'); return; }
    setApplyResult({ summary: null, reverted: body });
    const refreshed = await api(`/api/admin/imports/${importId}`);
    if (refreshed.status === 200) setJob(refreshed.body);
  }

  const enc = job?.encodingResult;
  const detected = job?.detectedEncoding ?? job?.detected_encoding;
  const openReader = job?.committedWorkId;
  const cls = (k: string) => diff?.match.items.filter((i: any) => i.itemClass === k).length ?? 0;
  const pending = diff
    ? diff.match.items.filter((i: any) => ['ambiguous', 'structural_conflict'].includes(i.itemClass)).length
    : 0;

  return (
    <>
      <section className="admin-panel">
        <h2>匯入</h2>
        <p className="muted">
          上傳 TXT 或 EPUB 建立新作品，或指定既有作品做增量／覆蓋。提交只會產生草稿——
          公開內容在「發布」頁才會變動。
        </p>

        {openReader && (
          <p className="form-ok">
            作品 <code className="mono">{openReader}</code> 已就緒。{' '}
            <button className="linkish" onClick={() => navigate(`/read/${openReader}`)}>開啟閱讀器</button>
          </p>
        )}

        <form className="form-grid" onSubmit={submit}>
          <div className="field">
            <label htmlFor="imp-file">來源檔案</label>
            <input className="input" id="imp-file" type="file" accept=".txt,.epub" required
              aria-describedby="imp-file-hint"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="hint" id="imp-file-hint">TXT 上限 30 MiB，EPUB 上限 50 MiB。</span>
          </div>
          <div className="field">
            <label htmlFor="imp-title">作品名稱</label>
            <input className="input" id="imp-title" value={title} placeholder="例如：長夜將盡"
              aria-describedby="imp-title-hint" onChange={(e) => setTitle(e.target.value)} />
            <span className="hint" id="imp-title-hint">提交為草稿時建立；增量匯入可留空。</span>
          </div>
          <div className="field">
            <label htmlFor="imp-type">作品類型</label>
            <select className="input" id="imp-type" value={workType} onChange={(e) => setWorkType(e.target.value)}>
              <option value="serial">長篇連載</option>
              <option value="short_story">短篇小說</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-work">目標作品 ID</label>
            <input className="input input-mono" id="imp-work" value={workId} placeholder="work UUID"
              aria-describedby="imp-work-hint" onChange={(e) => setWorkId(e.target.value)} />
            <span className="hint" id="imp-work-hint">留空＝建立新作品。填入才會進入增量／覆蓋流程。</span>
          </div>
          <div className="field">
            <label htmlFor="imp-enc">文字編碼</label>
            <select className="input" id="imp-enc" value={encoding} onChange={(e) => setEncoding(e.target.value)}>
              {ENCODINGS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <span className="hint">偵測結果不對時再指定，然後重新解析。</span>
          </div>
          <button className="btn primary" type="submit" disabled={busy || !file} aria-busy={busy || undefined}>
            {busy ? '處理中…' : '上傳並解析'}
          </button>
        </form>

        {error && <p className="form-error" role="alert">{error}</p>}
      </section>

      {job && (
        <section className="admin-panel">
          <h2>匯入狀態</h2>
          <p><Status status={job.status} /></p>

          {job.sourceFile && (
            <p className="hint">
              {job.sourceFile.mimeType}　·　{count(job.sourceFile.sizeBytes)} bytes　·
              sha256 <span className="mono">{String(job.sourceFile.fileHash).slice(0, 12)}…</span>
            </p>
          )}

          {detected && (
            <dl className="meta-grid">
              <dt>編碼</dt>
              <dd>{detected}{enc?.confidence ? `（信心 ${enc.confidence}）` : ''}</dd>
              {enc?.reason && (<><dt>依據</dt><dd>{enc.reason}</dd></>)}
            </dl>
          )}

          {enc?.warnings?.length > 0 && (
            <ul>
              {enc.warnings.map((w: string, i: number) => <li key={i} className="form-warn">{w}</li>)}
            </ul>
          )}

          {job.status === 'failed' && (
            <>
              <p className="form-error" role="alert">
                {job.errorCode}{job.errorDetail ? ` — ${job.errorDetail}` : ''}
              </p>
              <button className="btn" onClick={() => reanalyze(encoding)} disabled={busy}>
                {encoding ? `以 ${encoding} 重新解析` : '重新解析'}
              </button>
            </>
          )}

          {(job.status === 'ready' || job.status === 'review_required' || job.status === 'applied') && job.workId && (
            <>
              <h3>與現有章節比對</h3>
              <button className="btn" onClick={loadDiff} disabled={busy}>載入比對結果</button>
              {diff && (
                <>
                  <div className="tally">
                    <div><b>{cls('unchanged')}</b>相同</div>
                    <div><b>{cls('modified')}</b>有修訂</div>
                    <div><b>{cls('new')}</b>新章</div>
                    <div><b>{pending}</b>待決</div>
                    <div><b>{diff.match.missingFromSource.length}</b>來源缺失</div>
                  </div>
                  <p className="hint">基準版本 edit_version = {diff.editVersion}；增量模式會保留站方已修訂的內容。</p>
                  {diff.match.needsReview && (
                    <p className="form-warn">
                      有項目需要決策，待決清單會出現在套用的錯誤訊息裡。找不到錨點的新章可選「確認追加到結尾」。
                    </p>
                  )}
                  <div className="row-actions">
                    <button className="btn primary" onClick={() => applyIncremental('incremental')}
                      disabled={busy || job.status === 'applied'}>
                      套用增量
                    </button>
                    <button className="btn" onClick={() => {
                      if (confirm('覆蓋會為每個有差異的章節建立新修訂，站方先前的修改會被來源內容取代。確定要覆蓋嗎？')) {
                        void applyIncremental('overwrite');
                      }
                    }} disabled={busy || job.status === 'applied'}>
                      套用覆蓋
                    </button>
                    <button className="btn" onClick={() => applyIncremental('incremental', true)}
                      disabled={busy || job.status === 'applied'}>
                      確認追加到結尾
                    </button>
                  </div>
                </>
              )}

              {applyResult?.summary && (
                <p className="form-ok">
                  已套用（{applyResult.summary.updated > 0 || applyResult.modifiedMode ? '覆蓋' : '增量'}）：
                  新增 {applyResult.summary.added}、更新 {applyResult.summary.updated}、
                  相同 {applyResult.summary.unchanged}、保留站方修訂 {applyResult.summary.modifiedKept}、
                  略過 {applyResult.summary.skipped}、保留缺失 {applyResult.summary.missingKept}；
                  edit_version → {applyResult.newEditVersion}。
                </p>
              )}
              {applyResult?.reverted && (
                <p className="form-ok">
                  已回復：移除 {applyResult.reverted.removedChapters} 章、
                  還原 {applyResult.reverted.restoredRevisions} 個修訂；
                  edit_version → {applyResult.reverted.editVersion}。
                </p>
              )}
              {job.status === 'applied' && (
                <p>
                  <button className="btn" disabled={busy} onClick={() => {
                    if (confirm('回復會移除這次套用新增的章節並還原被覆蓋的修訂。之後若已有其他修改，回復會被擋下。確定要回復嗎？')) {
                      void doRevert();
                    }
                  }}>
                    回復此次套用
                  </button>
                </p>
              )}
            </>
          )}

          {(job.status === 'ready' || job.status === 'review_required') && (
            <>
              <h3>
                偵測章節 {count(job.stagedChapters)} 章
                {job.stagedNeedsReview > 0 && <span className="form-warn">　{job.stagedNeedsReview} 章需要覆核</span>}
              </h3>
              <ChapterList importId={importId!} />
              {!job.workId && (
                <button className="btn primary btn-block" onClick={commit} disabled={busy}>
                  {job.status === 'review_required' ? '覆核後提交為草稿' : '提交為草稿'}
                </button>
              )}
            </>
          )}

          {job.status === 'committed' && commitResult && (
            <p className="form-ok">
              已提交：作品 <span className="mono">{commitResult.workId}</span>，
              共 {count(commitResult.chapterCount)} 章（草稿，未公開）。{' '}
              <button className="linkish" onClick={() => navigate(`/read/${commitResult.workId}`)}>開啟閱讀器</button>
            </p>
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

  if (!data) {
    return (
      <div role="status" aria-label="載入章節">
        {Array.from({ length: 5 }, (_, i) => (
          <div className="sk sk-line" key={i} style={{ height: '1.1em', margin: '16px 0' }} aria-hidden="true" />
        ))}
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(data.total / data.limit));
  return (
    <div>
      <ol className="rows">
        {data.chapters.map((c: any) => (
          <li className="row" key={c.position}>
            <div className="row-main">
              <span className="row-title" style={{ fontSize: 'var(--text-base)' }}>
                {c.labelRaw || '（無標籤）'}{c.title ? `　${c.title}` : ''}
              </span>
              <div className="row-sub">
                <span className="snippet">{c.snippet}…</span>
                {c.warnings?.length > 0 && <span className="form-warn">{c.warnings.join('、')}</span>}
              </div>
            </div>
            <div className="row-rail">
              {c.needsReview
                ? <span className="state state-review">需覆核</span>
                : <span className="state state-ok">可提交</span>}
            </div>
          </li>
        ))}
      </ol>
      <div className="row-actions" style={{ alignItems: 'center' }}>
        <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一頁</button>
        <span className="hint tnum">第 {data.page} / {pages} 頁</span>
        <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一頁</button>
      </div>
    </div>
  );
}
