// Admin: upload → poll → preview → commit → diff/apply/revert (M2–M4) plus
// publish and taxonomy (M6). Same token vocabulary as the member surfaces — the
// person reviewing machine output deserves the same legibility as the reader.
import { useEffect, useRef, useState } from 'react';
import { navigate } from '../App.tsx';
import { PublishPanel } from './PublishPanel.tsx';
import { TaxonomyPanel } from './TaxonomyPanel.tsx';
import { count } from '../lib/format.ts';
import { SkeletonLines } from '../components/Skeleton.tsx';
import { BatchImportPanel } from './BatchImportPanel.tsx';
import { ContentReportsPanel } from './ContentReportsPanel.tsx';
import { ChapterEditor } from './ChapterEditor.tsx';
import { ExportPanel } from './ExportPanel.tsx';
import { api as request, ApiRequestError, getMe, login, logout } from '../api/client.ts';
import type { Me } from '../api/types.ts';
import type { ImportJob, ImportQuality, ImportChapterPage } from '../api/import-types.ts';
import { useImportMonitor } from './useImportMonitor.ts';

// Older incremental actions inspect HTTP error bodies to display resolution details.
// Keep that contract while sharing credentials, parsing and transport errors.
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  try { return { status: 200, body: await request(path, init) }; }
  catch (error) {
    if (error instanceof ApiRequestError) return { status: error.status, body: error.body };
    throw error;
  }
}

const STATUS_TEXT: Record<string, string> = {
  queued: '排隊中', processing: '解析中', review_required: '解析完成，有提示',
  ready: '解析完成', failed: '失敗', cancelled: '已取消', committed: '已儲存草稿', applied: '已套用增量',
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
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getMe().then(({ user }) => setMe(user)).catch(() => setMe(null));
  }, []);

  if (me === undefined) {
    return (
      <div className="app-main admin-shell">
        <SkeletonLines count={1} label="載入管理介面" />
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
            setBusy(true); setLoginError('');
            try {
              await login(email, password);
              const result = await getMe();
              setMe(result.user);
            } catch (error) {
              setLoginError(error instanceof ApiRequestError ? '登入失敗，請確認帳號與密碼' : '網絡連線失敗，請重試');
            } finally { setBusy(false); }
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
          {loginError && <p className="form-error" role="alert">{loginError}</p>}
          <div className="row-actions">
            <button className="btn" onClick={async () => {
              try { await logout(); setMe(null); }
              catch { setLoginError('登出失敗，請重試'); }
            }}>登出</button>
            <button className="btn" onClick={() => navigate('/')}>回書庫</button>
          </div>
        </div>
      </main>
    );
  }

  return <AdminHome email={email || 'admin'} onLogout={() => setMe(null)} />;
}

function AdminHome({ email, onLogout }: { email: string; onLogout(): void }) {
  const params = new URLSearchParams(location.search);
  const initialTab = params.get('tab');
  const [tab, setTab] = useState<'import' | 'publish' | 'taxonomy' | 'reports'>(initialTab === 'publish' || initialTab === 'taxonomy' || initialTab === 'reports' ? initialTab : 'import');
  const [selectedWorkId, setSelectedWorkId] = useState(params.get('work') ?? '');
  const [targetChapter, setTargetChapter] = useState(params.get('chapter') ?? '');
  const [targetParagraph, setTargetParagraph] = useState(Number(params.get('paragraph') ?? 0));
  const [batchMode, setBatchMode] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [exportRevision, setExportRevision] = useState(0);
  const [logoutError, setLogoutError] = useState('');
  useEffect(() => {
    const query = new URLSearchParams();
    query.set('tab', tab);
    if (selectedWorkId) query.set('work', selectedWorkId);
    if (tab === 'publish' && targetChapter) { query.set('chapter', targetChapter); query.set('paragraph', String(targetParagraph)); }
    history.replaceState(null, '', `/admin?${query}`);
  }, [tab, selectedWorkId, targetChapter, targetParagraph]);
  function continueToPublish(id: string) { setSelectedWorkId(id); setTab('publish'); }
  return (
    <main className="app-main admin-shell">
      <header className="page-head">
        <div className="head-line">
          <h1>管理後台</h1>
          <span className="head-note">
            {email}
            {'　'}
            <button className="linkish" onClick={async () => {
              try { await logout(); onLogout(); }
              catch { setLogoutError('登出失敗，請重試'); }
            }}>登出</button>
          </span>
        </div>
        <div className="seg" role="tablist" aria-label="管理功能">
          {([
            ['import', '匯入'],
            ['publish', '草稿與發布'],
            ['taxonomy', '分類標籤'],
            ['reports', '錯字回報'],
          ] as const).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={tab === v} className="seg-item"
              onClick={() => setTab(v)}>
              {label}
            </button>
          ))}
        </div>
      </header>
      {logoutError && <p className="form-error" role="alert">{logoutError}</p>}
      <div hidden={tab !== 'import'}>{batchMode
        ? <BatchImportPanel onBack={() => setBatchMode(false)} onOpenWork={(id) => { setBatchMode(false); continueToPublish(id); }} />
        : <ImportPanel onContinue={continueToPublish} onBatch={() => setBatchMode(true)} />}</div>
      {tab === 'publish' && <>
        <PublishPanel workId={selectedWorkId} onWorkChange={(id) => { setSelectedWorkId(id); setTargetChapter(''); }} refreshVersion={workspaceRevision}
          onPublished={() => setExportRevision((value) => value + 1)} />
        <ChapterEditor workId={selectedWorkId} initialChapterId={targetChapter} initialParagraphIndex={targetParagraph} onChanged={() => setWorkspaceRevision((value) => value + 1)} />
        <ExportPanel workId={selectedWorkId} refresh={exportRevision} />
      </>}
      {tab === 'reports' && <ContentReportsPanel onEdit={(id, chapterId, paragraphIndex) => {
        setSelectedWorkId(id); setTargetChapter(chapterId); setTargetParagraph(paragraphIndex); setTab('publish');
      }} />}
      {tab === 'taxonomy' && <TaxonomyPanel />}
    </main>
  );
}

const ENCODINGS = [
  { v: '', label: '自動偵測' },
  { v: 'utf-8', label: 'UTF-8' },
  { v: 'utf-16le', label: 'UTF-16 LE' },
  { v: 'utf-16be', label: 'UTF-16 BE' },
  { v: 'big5', label: 'Big5' },
  { v: 'gb18030', label: 'GB18030' },
];

function ImportPanel({ onContinue, onBatch }: { onContinue(id: string): void; onBatch(): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState('');
  const [jobUsesPastedText, setJobUsesPastedText] = useState(false);
  const [title, setTitle] = useState('');
  const [workType, setWorkType] = useState('serial');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [serialStatus, setSerialStatus] = useState('');
  const [encoding, setEncoding] = useState('');
  const [workId, setWorkId] = useState('');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [quality, setQuality] = useState<ImportQuality | null>(null);
  const [diff, setDiff] = useState<any>(null);
  const [applyResult, setApplyResult] = useState<any>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const metadataAppliedRef = useRef(false);
  const monitor = useImportMonitor((_id, { job: nextJob, quality: nextQuality, error: nextError }) => {
    if (nextJob) setJob(nextJob);
    if (nextQuality) setQuality(nextQuality);
    setError(nextError ?? '');
    const metadata = nextJob?.encodingResult?.metadata;
    if (metadata && !metadataAppliedRef.current) {
      metadataAppliedRef.current = true;
      setTitle((value) => value || metadata.title || '');
      setAuthor((value) => value || metadata.author || '');
      setDescription((value) => value || metadata.description || '');
      setSerialStatus((value) => value || metadata.serialStatus || '');
    }
  });
  const poll = monitor.watch;
  async function runImportAction(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); }
    catch (error) { setError(error instanceof ApiRequestError ? error.code : '網絡連線失敗，請重試'); }
    finally { setBusy(false); }
  }
  const submit = (e: React.FormEvent) => runImportAction(() => submitRequest(e));
  const reanalyze = (enc = '') => runImportAction(() => reanalyzeRequest(enc));
  const commit = () => runImportAction(commitRequest);
  const loadDiff = () => runImportAction(loadDiffRequest);
  const applyIncremental = (mode: 'incremental' | 'overwrite', confirmAppend = false) =>
    runImportAction(() => applyIncrementalRequest(mode, confirmAppend));
  const doRevert = () => runImportAction(doRevertRequest);

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    const isPastedText = pastedText.trim().length > 0;
    const source = isPastedText ? new File([pastedText], 'pasted.txt', { type: 'text/plain' }) : file;
    if (!source) return;
    monitor.stop();
    metadataAppliedRef.current = false;
    setImportId(null);
    setError(''); setJob(null); setQuality(null); setDiff(null); setApplyResult(null);
    setJobUsesPastedText(false);
    const form = new FormData();
    form.append('file', source);
    if (title) form.append('title', title); // display hint only; real title goes to commit
    if (encoding && !isPastedText) form.append('encoding', encoding);
    if (workId) form.append('workId', workId);
    const { status, body } = await api('/api/admin/imports', { method: 'POST', body: form });
    if (status !== 200) { setError(body.error ?? '提交失敗'); return; }
    setJobUsesPastedText(isPastedText);
    if (isPastedText) setPastedText('');
    setImportId(body.importId);
    poll(body.importId);
  }

  async function reanalyzeRequest(enc = '') {
    if (!importId) return;
    monitor.stop(importId);
    setQuality(null);
    try {
      const { status, body } = await api(`/api/admin/imports/${importId}/reanalyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(enc ? { encoding: enc } : {}),
      });
      if (status !== 200) { setError(body.error ?? '重新解析失敗'); return; }
      setJob((j) => j && { ...j, status: 'queued' });
    } finally {
      // The server may have accepted a POST whose response was lost. Reconcile either way.
      poll(importId);
    }
  }

  async function commitRequest() {
    if (!importId) return;
    monitor.stop(importId);
    setError('');
    const { status, body } = await api(`/api/admin/imports/${importId}/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title || '未命名作品', workType, author, description,
        serialStatus: workType === 'serial' ? serialStatus || null : null }),
    });
    if (status !== 200) { setError(`${body.error ?? 'commit 失敗'}${body.detail ? `：${body.detail}` : ''}`); return; }
    const refreshed = await api(`/api/admin/imports/${importId}`);
    if (refreshed.status === 200) setJob(refreshed.body);
    onContinue(body.workId);
  }

  async function loadDiffRequest() {
    if (!importId) return;
    setError('');
    const { status, body } = await api(`/api/admin/imports/${importId}/diff`);
    if (status !== 200) { setError(body.error ?? '比對失敗'); return; }
    setDiff(body);
  }

  async function applyIncrementalRequest(mode: 'incremental' | 'overwrite', confirmAppend = false) {
    if (!importId || !diff) return;
    monitor.stop(importId);
    setError('');
    const key = `ui-${importId}-${mode}-${Date.now()}`;
    const { status, body } = await api(`/api/admin/imports/${importId}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ baseEditVersion: diff.editVersion, mode, confirmAppend }),
    });
    if (status !== 200) { setError(`${body.error ?? '套用失敗'}${body.unresolved?.length ? `（${body.unresolved.length} 項待決：${body.unresolved.map((u: any) => u.labelRaw).join('、')}）` : ''}`); return; }
    setApplyResult(body);
    const refreshed = await api(`/api/admin/imports/${importId}`);
    if (refreshed.status === 200) setJob(refreshed.body);
  }

  async function doRevertRequest() {
    if (!importId || !diff) return;
    monitor.stop(importId);
    setError('');
    const plan = await api(`/api/admin/imports/${importId}/revert-plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    if (plan.status !== 200 || !plan.body.canRevert) {
      setError(`無法回復：${plan.body?.reason ?? plan.body?.error ?? '未知原因'}`);
      return;
    }
    const { status, body } = await api(`/api/admin/imports/${importId}/revert`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseEditVersion: plan.body.plan.editVersionFrom }),
    });
    if (status !== 200) { setError(body.error ?? '回復失敗'); return; }
    setApplyResult({ summary: null, reverted: body });
    const refreshed = await api(`/api/admin/imports/${importId}`);
    if (refreshed.status === 200) setJob(refreshed.body);
  }

  const enc = job?.encodingResult;
  const detected = job?.detectedEncoding;
  const draftWorkId = job?.committedWorkId ?? (job?.status === 'applied' ? job.workId : null);
  const cls = (k: string) => diff?.match.items.filter((i: any) => i.itemClass === k).length ?? 0;
  const pending = diff
    ? diff.match.items.filter((i: any) => ['ambiguous', 'structural_conflict'].includes(i.itemClass)).length
    : 0;

  return (
    <>
      <section className="admin-panel">
        <div className="head-line"><h2>匯入作品</h2><button className="linkish" onClick={onBatch}>批量匯入多本</button></div>
        <p className="hint">流程：匯入 → 快速確認 → 發布</p>
        <p className="muted">
          上傳 TXT／EPUB 檔案或貼上 TXT 文字建立新作品，也可指定既有作品做增量／覆蓋。提交只會產生草稿——
          公開內容在「發布」頁才會變動。
        </p>



        <form className="form-grid import-form" onSubmit={submit}>
          <div className="import-source">
          <div className="field">
            <label htmlFor="imp-file">來源檔案</label>
            <input ref={fileInputRef} className="input" id="imp-file" type="file" accept=".txt,.epub" disabled={busy}
              aria-describedby="imp-file-hint"
              onChange={(e) => {
                const nextFile = e.target.files?.[0] ?? null;
                setFile(nextFile);
                if (nextFile) setPastedText('');
              }} />
            <span className="hint" id="imp-file-hint">TXT 上限 30 MiB，EPUB 上限 50 MiB。</span>
          </div>
          <div className="field">
            <label htmlFor="imp-text">或貼上 TXT 內容</label>
            <textarea className="input" id="imp-text" rows={8} value={pastedText} disabled={busy}
              aria-describedby="imp-text-hint"
              placeholder="在此貼上文字內容…"
              onChange={(e) => {
                const text = e.target.value;
                setPastedText(text);
                if (text.length > 0) {
                  setFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                  setEncoding('');
                }
              }} />
            <span className="hint" id="imp-text-hint">TXT 上限 30 MiB；貼上內容以 UTF-8 匯入，請與來源檔案擇一。</span>
          </div>
          </div>
          <div className="import-metadata">
          <div className="field">
            <label htmlFor="imp-title">作品名稱</label>
            <input className="input" id="imp-title" value={title} placeholder="例如：長夜將盡"
              aria-describedby="imp-title-hint" onChange={(e) => setTitle(e.target.value)} />
            <span className="hint" id="imp-title-hint">解析後會自動填入來源中的作品資料；可修改。以下資料只用於建立新作品。</span>
          </div>
          <div className="field">
            <label htmlFor="imp-author">作者</label>
            <input className="input" id="imp-author" value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div className="field field-wide">
            <label htmlFor="imp-description">簡介</label>
            <textarea className="input" id="imp-description" rows={4} value={description}
              onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="imp-type">作品類型</label>
            <select className="input" id="imp-type" value={workType} onChange={(e) => setWorkType(e.target.value)}>
              <option value="serial">長篇連載</option>
              <option value="short_story">短篇小說</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-status">連載狀態</label>
            <select className="input" id="imp-status" value={serialStatus} disabled={workType !== 'serial'}
              aria-describedby="imp-status-hint" onChange={(e) => setSerialStatus(e.target.value)}>
              <option value="">待確認</option>
              <option value="ongoing">未完結</option>
              <option value="completed">完結</option>
            </select>
            <span className="hint" id="imp-status-hint">來源沒有註明時請自行選擇；短篇小說不設定連載狀態。</span>
          </div>
          </div>
          <div className="import-actions">
          <details><summary>進階匯入設定（更新既有作品／指定編碼）</summary>
          <div className="field">
            <label htmlFor="imp-work">目標作品 ID</label>
            <input className="input input-mono" id="imp-work" value={workId} placeholder="work UUID"
              aria-describedby="imp-work-hint" onChange={(e) => setWorkId(e.target.value)} />
            <span className="hint" id="imp-work-hint">留空＝建立新作品。填入才會進入增量／覆蓋流程。</span>
          </div>
          <div className="field">
            <label htmlFor="imp-enc">文字編碼</label>
            <select className="input" id="imp-enc" value={encoding} disabled={jobUsesPastedText || pastedText.trim().length > 0}
              onChange={(e) => setEncoding(e.target.value)}>
              {ENCODINGS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <span className="hint">{jobUsesPastedText ? '貼上內容以 UTF-8 儲存。' : '偵測結果不對時再指定，然後重新解析。'}</span>
          </div>
          </details>
          <button className="btn primary" type="submit" disabled={busy || (!file && !pastedText.trim())} aria-busy={busy || undefined}>
            {busy ? '處理中…' : '提交並解析'}
          </button>
          </div>
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

          {enc && enc.warnings.length > 0 && (
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
                {job.stagedNeedsReview > 0 && <span className="form-warn">　{job.stagedNeedsReview} 章有解析提示</span>}
              </h3>
              <p className="hint">確認章數及作品資料即可繼續；有疑問時才展開章節清單抽查。</p>
              {quality && <div className={quality.issueCount ? 'form-warn' : 'form-ok'}>
                <p>章節異常檢查：空章 {quality.counts.empty}、重複章 {quality.counts.duplicates}、章號跳號 {quality.counts.gaps}。</p>
                {quality.issues.length > 0 && <details><summary>查看 {quality.issueCount} 項異常位置</summary>
                  <ul>{quality.issues.map((issue, index) => <li key={`${issue.type}-${index}`}>
                    {issue.message}：{issue.positions.map((position: number, i: number) => `第 ${position + 1} 項${issue.labels[i] ? `（${issue.labels[i]}）` : ''}`).join('、')}
                  </li>)}</ul>
                </details>}
              </div>}
              <details><summary>查看章節清單與解析提示（可選）</summary>
                <ChapterList key={importId} importId={importId!} />
              </details>
              {!job.workId && (
                <button className="btn primary btn-block" onClick={commit} disabled={busy}>
                  {busy ? '儲存中…' : '繼續發布'}
                </button>
              )}
            </>
          )}

          {draftWorkId && (
            <div role="status">
              <h3>{job.status === 'applied' ? '修改已儲存' : '草稿已建立'}</h3>
              <p>內容已儲存，可直接前往快速確認及發布。</p>
              <div className="row-actions">
                <button className="btn primary" onClick={() => onContinue(draftWorkId)}>繼續發布</button>
              </div>
              <p className="hint">稍後也可在「草稿與發布」按作品名稱找到它。</p>
            </div>
          )}

        </section>
      )}
    </>
  );
}

function ChapterList({ importId }: { importId: string }) {
  const [data, setData] = useState<ImportChapterPage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const controller = new AbortController();
    setData(null); setLoadError('');
    request<ImportChapterPage>(`/api/admin/imports/${importId}/chapters?page=${page}&limit=50`, { signal: controller.signal })
      .then((body) => { if (!controller.signal.aborted) setData(body); })
      .catch(() => { if (!controller.signal.aborted) setLoadError('章節載入失敗，請重新開啟預覽或換頁重試'); });
    return () => controller.abort();
  }, [importId, page]);

  if (loadError) return <p className="form-error" role="alert">{loadError}</p>;
  if (!data) return <SkeletonLines count={5} label="載入章節" />;

  const pages = Math.max(1, Math.ceil(data.total / data.limit));
  return (
    <div>
      <ol className="rows">
        {data.chapters.map((c) => (
          <li className="row" key={c.position}>
            <div className="row-main">
              <span className="row-title row-title-sm">
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
      <div className="row-actions pager">
        <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一頁</button>
        <span className="hint tnum">第 {data.page} / {pages} 頁</span>
        <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一頁</button>
      </div>
    </div>
  );
}
