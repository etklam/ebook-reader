// Admin: upload → poll → preview → commit → diff/apply/revert (M2–M4) plus
// publish and taxonomy (M6). Same token vocabulary as the member surfaces — the
// person reviewing machine output deserves the same legibility as the reader.
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { ImportReview } from './ImportReview.tsx';
import { WorkPicker } from './WorkPicker.tsx';
import { useImportMonitor } from './useImportMonitor.ts';
import { TaxonomyPicker, type TaxonomySelection } from './TaxonomyPicker.tsx';
import { AppFooter } from '../components/AppFooter.tsx';
import { t } from '../i18n/translate.ts';

// Older incremental actions inspect HTTP error bodies to display resolution details.
// Keep that contract while sharing credentials, parsing and transport errors.
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  try { return { status: 200, body: await request(path, init) }; }
  catch (error) {
    if (error instanceof ApiRequestError) return { status: error.status, body: error.body };
    throw error;
  }
}

// source strings; translated where they are rendered
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
      {STATUS_TEXT[status] ? t(STATUS_TEXT[status]) : status}
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
        <SkeletonLines count={1} label={t('載入管理介面')} />
      </div>
    );
  }

  if (!me) {
    return (
      <main className="app-main admin-shell">
        <div className="auth-page">
          <h1>{t('管理員登入')}</h1>
          <p className="auth-lede">{t('匯入、發布與分類管理需要管理員帳號。')}</p>
          <form className="auth-form" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true); setLoginError('');
            try {
              await login(email, password);
              const result = await getMe();
              setMe(result.user);
            } catch (error) {
              setLoginError(error instanceof ApiRequestError ? t('登入失敗，請確認帳號與密碼') : t('網絡連線失敗，請重試'));
            } finally { setBusy(false); }
          }}>
            <div className="field">
              <label htmlFor="admin-email">{t('電子郵件')}</label>
              <input className="input" id="admin-email" type="email" value={email} required
                autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="admin-password">{t('密碼')}</label>
              <input className="input" id="admin-password" type="password" value={password} required
                autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
            </div>
            {loginError && <p className="form-error" role="alert">{loginError}</p>}
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? t('登入中…') : t('登入')}
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
          <h2>{t('這個帳號不是管理員')}</h2>
          <p>{t('管理後台只開放給管理員帳號。可以改用其他帳號登入，或回書庫繼續閱讀。')}</p>
          {loginError && <p className="form-error" role="alert">{loginError}</p>}
          <div className="row-actions">
            <button className="btn" onClick={async () => {
              try { await logout(); setMe(null); }
              catch { setLoginError(t('登出失敗，請重試')); }
            }}>{t('登出')}</button>
            <button className="btn" onClick={() => navigate('/')}>{t('回書庫')}</button>
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
  // The work the import panel should open on, when the admin arrived there via
  // "重新匯入此作品" rather than through the import tab. Keyed so the panel
  // remounts and starts a fresh job instead of inheriting the previous one.
  const [reimport, setReimport] = useState<{ workId: string; key: number } | null>(null);
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
          <h1>{t('管理後台')}</h1>
          <span className="head-note">
            {email}
            {'　'}
            <button className="linkish" onClick={async () => {
              try { await logout(); onLogout(); }
              catch { setLogoutError(t('登出失敗，請重試')); }
            }}>{t('登出')}</button>
          </span>
        </div>
        <div className="seg" role="tablist" aria-label={t('管理功能')}>
          {([
            ['import', '匯入'],
            ['publish', '草稿與發布'],
            ['taxonomy', '分類標籤'],
            ['reports', '錯字回報'],
          ] as const).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={tab === v} className="seg-item"
              onClick={() => setTab(v)}>
              {t(label)}
            </button>
          ))}
        </div>
      </header>
      {logoutError && <p className="form-error" role="alert">{logoutError}</p>}
      <div hidden={tab !== 'import'}>{batchMode
        ? <BatchImportPanel onBack={() => setBatchMode(false)} onOpenWork={(id) => { setBatchMode(false); continueToPublish(id); }} />
        : <ImportPanel key={reimport?.key ?? 'new'} initialWorkId={reimport?.workId ?? ''}
            onContinue={continueToPublish} onBatch={() => setBatchMode(true)} />}</div>
      {tab === 'publish' && <>
        <PublishPanel workId={selectedWorkId} onWorkChange={(id) => { setSelectedWorkId(id); setTargetChapter(''); }} refreshVersion={workspaceRevision}
          onPublished={() => setExportRevision((value) => value + 1)}
          onReimport={(id) => {
            setReimport({ workId: id, key: Date.now() });
            setBatchMode(false);
            setTab('import');
          }} />
        <ChapterEditor workId={selectedWorkId} initialChapterId={targetChapter} initialParagraphIndex={targetParagraph} onChanged={() => setWorkspaceRevision((value) => value + 1)} />
        <ExportPanel workId={selectedWorkId} refresh={exportRevision} />
      </>}
      {tab === 'reports' && <ContentReportsPanel onEdit={(id, chapterId, paragraphIndex) => {
        setSelectedWorkId(id); setTargetChapter(chapterId); setTargetParagraph(paragraphIndex); setTab('publish');
      }} />}
      {tab === 'taxonomy' && <TaxonomyPanel />}
      <AppFooter />
    </main>
  );
}

// labels translated at the render site: a constant runs once at import
const ENCODINGS = [
  { v: '', label: '自動偵測' },
  { v: 'utf-8', label: 'UTF-8' },
  { v: 'utf-16le', label: 'UTF-16 LE' },
  { v: 'utf-16be', label: 'UTF-16 BE' },
  { v: 'big5', label: 'Big5' },
  { v: 'gb18030', label: 'GB18030' },
];

function ImportPanel({ onContinue, onBatch, initialWorkId = '' }: {
  onContinue(id: string): void; onBatch(): void;
  /** handed over by "重新匯入此作品" in the publish panel */
  initialWorkId?: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState('');
  const [jobUsesPastedText, setJobUsesPastedText] = useState(false);
  const [title, setTitle] = useState('');
  const [workType, setWorkType] = useState('serial');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [serialStatus, setSerialStatus] = useState('');
  const [taxonomy, setTaxonomy] = useState<TaxonomySelection>({ categoryIds: [], tagIds: [] });
  const [encoding, setEncoding] = useState('');
  const [workId, setWorkId] = useState(initialWorkId);
  const [mode, setMode] = useState<'new' | 'update'>(initialWorkId ? 'update' : 'new');
  const updating = mode === 'update';
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
      // keywords stay as suggestions; only the admin's clicks assign taxonomy
      metadataAppliedRef.current = true;
      setTitle((value) => value || metadata.title || '');
      setAuthor((value) => value || metadata.author || '');
      setDescription((value) => value || metadata.description || '');
      setSerialStatus((value) => value || metadata.serialStatus || '');
    }
  });
  const poll = monitor.watch;
  const sourceKeywords = job?.encodingResult?.metadata?.keywords;
  const keywords = useMemo(() => sourceKeywords ?? [], [sourceKeywords]);
  async function runImportAction(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); }
    catch (error) { setError(error instanceof ApiRequestError ? error.code : t('網絡連線失敗，請重試')); }
    finally { setBusy(false); }
  }
  const submit = (e: React.FormEvent) => runImportAction(() => submitRequest(e));
  const reanalyze = (enc = '') => runImportAction(() => reanalyzeRequest(enc));
  const commit = () => runImportAction(commitRequest);
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
    // Only ever in update mode, and only with a target: without this guard an
    // "update" with nothing selected would quietly create a duplicate work,
    // which is the exact outcome this flow exists to avoid.
    if (updating) {
      if (!workId) { setError(t('請先選擇要更新的作品。')); return; }
      form.append('workId', workId);
    }
    const { status, body } = await api('/api/admin/imports', { method: 'POST', body: form });
    if (status !== 200) { setError(body.error ?? t('提交失敗')); return; }
    setJobUsesPastedText(isPastedText);
    if (isPastedText) setPastedText('');
    setImportId(body.importId);
    poll(body.importId);
  }

  async function reanalyzeRequest(enc = '') {
    if (!importId) return;
    monitor.stop(importId);
    setQuality(null); setDiff(null);
    try {
      const { status, body } = await api(`/api/admin/imports/${importId}/reanalyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(enc ? { encoding: enc } : {}),
      });
      if (status !== 200) { setError(body.error ?? t('重新解析失敗')); return; }
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
      body: JSON.stringify({ title: title || t('未命名作品'), workType, author, description,
        serialStatus: workType === 'serial' ? serialStatus || null : null,
        categoryIds: taxonomy.categoryIds, tagIds: taxonomy.tagIds }),
    });
    if (status !== 200) { setError(`${body.error ?? t('commit 失敗')}${body.detail ? `：${body.detail}` : ''}`); return; }
    const refreshed = await api(`/api/admin/imports/${importId}`);
    if (refreshed.status === 200) setJob(refreshed.body);
    onContinue(body.workId);
  }

  async function doRevertRequest() {
    if (!importId || !diff) return;
    monitor.stop(importId);
    setError('');
    const plan = await api(`/api/admin/imports/${importId}/revert-plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    if (plan.status !== 200 || !plan.body.canRevert) {
      setError(t('無法回復：{reason}', { reason: plan.body?.reason ?? plan.body?.error ?? t('未知原因') }));
      return;
    }
    const { status, body } = await api(`/api/admin/imports/${importId}/revert`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseEditVersion: plan.body.plan.editVersionFrom }),
    });
    if (status !== 200) { setError(body.error ?? t('回復失敗')); return; }
    setApplyResult({ summary: null, reverted: body });
    const refreshed = await api(`/api/admin/imports/${importId}`);
    if (refreshed.status === 200) setJob(refreshed.body);
  }

  const enc = job?.encodingResult;
  const detected = job?.detectedEncoding;
  const draftWorkId = job?.committedWorkId ?? (job?.status === 'applied' ? job.workId : null);


  return (
    <>
      <section className="admin-panel">
        <div className="head-line"><h2>{t('匯入作品')}</h2><button className="linkish" onClick={onBatch}>{t('批量匯入多本')}</button></div>
        <p className="hint">{updating ? t('流程：重新匯入 → 覆核差異 → 套用 → 發布') : t('流程：匯入 → 快速確認 → 發布')}</p>
        <p className="muted">
          {t('上傳 TXT／EPUB 檔案或貼上 TXT 文字。提交只會產生草稿——公開內容在「發布」頁才會變動。')}
        </p>

        {/* The target was the single most buried control in the admin UI: a
            hand-typed UUID inside a collapsed "advanced settings". It decides
            which of two quite different flows runs, so it is the first choice
            on the form, not the last. */}
        <div className="field">
          <span className="field-label" id="imp-mode-label">{t('這次匯入要')}</span>
          <div className="seg" role="radiogroup" aria-labelledby="imp-mode-label">
            {([['new', '建立新作品'], ['update', '更新既有作品']] as const).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={mode === value} className="seg-item"
                disabled={busy} onClick={() => { setMode(value); if (value === 'new') setWorkId(''); }}>
                {t(label)}
              </button>
            ))}
          </div>
          <span className="hint">{updating
            ? t('來源會與既有章節比對，再由你逐項覆核後套用；站方既有內容不會被自動覆寫。')
            : t('建立一部新草稿。要更新已經匯入過的作品，請改選「更新既有作品」，不要重新建立一部。')}</span>
        </div>
        {updating && <WorkPicker idPrefix="imp" value={workId} onChange={setWorkId} disabled={busy} />}


        <form className="form-grid import-form" onSubmit={submit}>
          <div className="import-source">
          <div className="field">
            <label htmlFor="imp-file">{t('來源檔案')}</label>
            <input ref={fileInputRef} className="input" id="imp-file" type="file" accept=".txt,.epub" disabled={busy}
              aria-describedby="imp-file-hint"
              onChange={(e) => {
                const nextFile = e.target.files?.[0] ?? null;
                setFile(nextFile);
                if (nextFile) setPastedText('');
              }} />
            <span className="hint" id="imp-file-hint">{t('TXT 上限 30 MiB，EPUB 上限 50 MiB。')}</span>
          </div>
          <div className="field">
            <label htmlFor="imp-text">{t('或貼上 TXT 內容')}</label>
            <textarea className="input" id="imp-text" rows={8} value={pastedText} disabled={busy}
              aria-describedby="imp-text-hint"
              placeholder={t('在此貼上文字內容…')}
              onChange={(e) => {
                const text = e.target.value;
                setPastedText(text);
                if (text.length > 0) {
                  setFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                  setEncoding('');
                }
              }} />
            <span className="hint" id="imp-text-hint">{t('TXT 上限 30 MiB；貼上內容以 UTF-8 匯入，請與來源檔案擇一。')}</span>
          </div>
          </div>
          {/* new-work metadata only: commit writes these, apply ignores them.
              Showing them while updating is what made the two flows look like
              one form with an obscure switch. */}
          <div className="import-metadata" hidden={updating}>
          <div className="field">
            <label htmlFor="imp-title">{t('作品名稱')}</label>
            <input className="input" id="imp-title" value={title} placeholder={t('例如：長夜將盡')}
              aria-describedby="imp-title-hint" onChange={(e) => setTitle(e.target.value)} />
            <span className="hint" id="imp-title-hint">{t('解析後會自動填入來源中的作品資料；可修改。以下資料只用於建立新作品。')}</span>
          </div>
          <div className="field">
            <label htmlFor="imp-author">{t('作者')}</label>
            <input className="input" id="imp-author" value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div className="field field-wide">
            <label htmlFor="imp-description">{t('簡介')}</label>
            <textarea className="input" id="imp-description" rows={4} value={description}
              onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="imp-type">{t('作品類型')}</label>
            <select className="input" id="imp-type" value={workType} onChange={(e) => setWorkType(e.target.value)}>
              <option value="serial">{t('長篇連載')}</option>
              <option value="short_story">{t('短篇小說')}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-status">{t('連載狀態')}</label>
            <select className="input" id="imp-status" value={serialStatus} disabled={workType !== 'serial'}
              aria-describedby="imp-status-hint" onChange={(e) => setSerialStatus(e.target.value)}>
              <option value="">{t('待確認')}</option>
              <option value="ongoing">{t('未完結')}</option>
              <option value="completed">{t('完結')}</option>
            </select>
            <span className="hint" id="imp-status-hint">{t('來源沒有註明時請自行選擇；短篇小說不設定連載狀態。')}</span>
          </div>
          <div className="field field-wide">
            <span className="field-label" id="imp-taxonomy-label">{t('分類與標籤')}</span>
            <span className="hint">{t('發布需要至少一個分類。在這裡選好，草稿建立時就一併寫入，不用發布前再補。')}</span>
            <TaxonomyPicker idPrefix="imp" value={taxonomy} onChange={setTaxonomy}
              keywords={keywords} disabled={busy} />
            {!taxonomy.categoryIds.length && (
              <p className="form-warn">{t('尚未選分類。仍可建立草稿，但發布前必須補上至少一個。')}</p>
            )}
          </div>
          </div>
          <div className="import-actions">
          <details><summary>{t('進階匯入設定（指定編碼）')}</summary>
          <div className="field">
            <label htmlFor="imp-enc">{t('文字編碼')}</label>
            <select className="input" id="imp-enc" value={encoding} disabled={jobUsesPastedText || pastedText.trim().length > 0}
              onChange={(e) => setEncoding(e.target.value)}>
              {ENCODINGS.map((o) => <option key={o.v} value={o.v}>{t(o.label)}</option>)}
            </select>
            <span className="hint">{jobUsesPastedText ? t('貼上內容以 UTF-8 儲存。') : t('偵測結果不對時再指定，然後重新解析。')}</span>
          </div>
          </details>
          <button className="btn primary" type="submit"
            disabled={busy || (!file && !pastedText.trim()) || (updating && !workId)} aria-busy={busy || undefined}>
            {busy ? t('處理中…') : updating ? t('提交並比對差異') : t('提交並解析')}
          </button>
          {updating && !workId && <span className="hint">{t('請先選擇要更新的作品。')}</span>}
          </div>
        </form>

        {error && <p className="form-error" role="alert">{error}</p>}
      </section>

      {job && (
        <section className="admin-panel">
          <h2>{t('匯入狀態')}</h2>
          <p><Status status={job.status} /></p>

          {job.sourceFile && (
            <p className="hint">
              {job.sourceFile.mimeType}　·　{count(job.sourceFile.sizeBytes)} bytes　·
              sha256 <span className="mono">{String(job.sourceFile.fileHash).slice(0, 12)}…</span>
            </p>
          )}

          {detected && (
            <dl className="meta-grid">
              <dt>{t('編碼')}</dt>
              <dd>{detected}{enc?.confidence ? t('（信心 {confidence}）', { confidence: enc.confidence }) : ''}</dd>
              {enc?.reason && (<><dt>{t('依據')}</dt><dd>{enc.reason}</dd></>)}
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
                {encoding ? t('以 {encoding} 重新解析', { encoding }) : t('重新解析')}
              </button>
            </>
          )}

          {(job.status === 'ready' || job.status === 'review_required' || job.status === 'applied') && job.workId && (
            <>
              <h3>{t('與現有章節比對')}</h3>
              <ImportReview key={importId} importId={importId!} applied={job.status === 'applied'}
                onBaseline={(editVersion) => setDiff({ editVersion })}
                onApplied={(result) => { setApplyResult(result); void api(`/api/admin/imports/${importId}`).then((response) => { if (response.status === 200) setJob(response.body); }); }} />

              {applyResult?.summary && (
                <p className="form-ok">
                  {t('已套用（{mode}）：新增 {added}、更新 {updated}、相同 {unchanged}、保留站方修訂 {kept}、略過 {skipped}、保留缺失 {missingKept}；', {
                    mode: applyResult.summary.updated > 0 || applyResult.modifiedMode ? t('覆蓋') : t('增量'),
                    added: applyResult.summary.added, updated: applyResult.summary.updated,
                    unchanged: applyResult.summary.unchanged, kept: applyResult.summary.modifiedKept,
                    skipped: applyResult.summary.skipped, missingKept: applyResult.summary.missingKept,
                  })}
                  edit_version → {applyResult.newEditVersion}。
                </p>
              )}
              {applyResult?.reverted && (
                <p className="form-ok">
                  {t('已回復：移除 {removed} 章、還原 {restored} 個修訂；', {
                    removed: applyResult.reverted.removedChapters, restored: applyResult.reverted.restoredRevisions,
                  })}
                  edit_version → {applyResult.reverted.editVersion}。
                </p>
              )}
              {job.status === 'applied' && (
                <p>
                  <button className="btn" disabled={busy} onClick={() => {
                    if (confirm(t('回復會移除這次套用新增的章節並還原被覆蓋的修訂。之後若已有其他修改，回復會被擋下。確定要回復嗎？'))) {
                      void doRevert();
                    }
                  }}>
                    {t('回復此次套用')}
                  </button>
                </p>
              )}
            </>
          )}

          {(job.status === 'ready' || job.status === 'review_required') && (
            <>
              <h3>
                {t('偵測章節 {n} 章', { n: count(job.stagedChapters) })}
                {job.stagedNeedsReview > 0 && <span className="form-warn">　{t('{n} 章有解析提示', { n: job.stagedNeedsReview })}</span>}
              </h3>
              <p className="hint">{t('確認章數及作品資料即可繼續；有疑問時才展開章節清單抽查。')}</p>
              {quality && <div className={quality.issueCount ? 'form-warn' : 'form-ok'}>
                <p>{t('章節異常檢查：空章 {empty}、重複章 {duplicates}、章號跳號 {gaps}。', {
                  empty: quality.counts.empty, duplicates: quality.counts.duplicates, gaps: quality.counts.gaps,
                })}</p>
                {quality.issues.length > 0 && <details><summary>{t('查看 {n} 項異常位置', { n: quality.issueCount })}</summary>
                  <ul>{quality.issues.map((issue, index) => <li key={`${issue.type}-${index}`}>
                    {issue.message}：{issue.positions.map((position: number, i: number) => (issue.labels[i]
                      ? t('第 {n} 項（{label}）', { n: position + 1, label: issue.labels[i] })
                      : t('第 {n} 項', { n: position + 1 }))).join('、')}
                  </li>)}</ul>
                </details>}
              </div>}
              <details><summary>{t('查看章節清單與解析提示（可選）')}</summary>
                <ChapterList key={importId} importId={importId!} />
              </details>
              {!job.workId && (
                <button className="btn primary btn-block" onClick={commit} disabled={busy}>
                  {busy ? t('儲存中…') : t('繼續發布')}
                </button>
              )}
            </>
          )}

          {draftWorkId && (
            <div role="status">
              <h3>{job.status === 'applied' ? t('修改已儲存') : t('草稿已建立')}</h3>
              <p>{t('內容已儲存，可直接前往快速確認及發布。')}</p>
              <div className="row-actions">
                <button className="btn primary" onClick={() => onContinue(draftWorkId)}>{t('繼續發布')}</button>
              </div>
              <p className="hint">{t('稍後也可在「草稿與發布」按作品名稱找到它。')}</p>
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
      .catch(() => { if (!controller.signal.aborted) setLoadError(t('章節載入失敗，請重新開啟預覽或換頁重試')); });
    return () => controller.abort();
  }, [importId, page]);

  if (loadError) return <p className="form-error" role="alert">{loadError}</p>;
  if (!data) return <SkeletonLines count={5} label={t('載入章節')} />;

  const pages = Math.max(1, Math.ceil(data.total / data.limit));
  return (
    <div>
      <ol className="rows">
        {data.chapters.map((c) => (
          <li className="row" key={c.position}>
            <div className="row-main">
              <span className="row-title row-title-sm">
                {c.labelRaw || t('（無標籤）')}{c.title ? `　${c.title}` : ''}
              </span>
              <div className="row-sub">
                <span className="snippet">{c.snippet}…</span>
                {c.warnings?.length > 0 && <span className="form-warn">{c.warnings.join('、')}</span>}
              </div>
            </div>
            <div className="row-rail">
              {c.needsReview
                ? <span className="state state-review">{t('需覆核')}</span>
                : <span className="state state-ok">{t('可提交')}</span>}
            </div>
          </li>
        ))}
      </ol>
      <div className="row-actions pager">
        <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('上一頁')}</button>
        <span className="hint tnum">{t('第 {page} / {pages} 頁', { page: data.page, pages })}</span>
        <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t('下一頁')}</button>
      </div>
    </div>
  );
}
