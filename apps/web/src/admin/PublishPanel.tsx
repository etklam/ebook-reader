// Draft review uses editorial HEAD; readers see only explicitly published releases.
import { useEffect, useState } from 'react';
import { api, getPublishPreview, publishWork } from '../api/client.ts';
import type { PublishPreviewResponse } from '../api/types.ts';
import { count } from '../lib/format.ts';
import { navigate } from '../App.tsx';
import { TaxonomyPicker, type TaxonomySelection } from './TaxonomyPicker.tsx';
import { t } from '../i18n/translate.ts';

type WorkOption = { id: string; title: string; author: string; activeReleaseId: string | null };
type Draft = {
  work: { title: string; author: string; description: string; serialStatus: string | null; workType: string };
  chapters: { id: string; labelRaw: string; title: string | null }[];
};
type Chapter = { chapterId: string; labelRaw: string; title: string; body: string };

export function PublishPanel({ workId, onWorkChange, refreshVersion = 0, onPublished }: {
  workId: string; onWorkChange(id: string): void; refreshVersion?: number; onPublished?(): void;
}) {
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [query, setQuery] = useState('');
  const [listError, setListError] = useState('');
  const [listBusy, setListBusy] = useState(false);
  const [preview, setPreview] = useState<PublishPreviewResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [chapterId, setChapterId] = useState('');
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [chapterError, setChapterError] = useState('');
  const [showChapter, setShowChapter] = useState(false);
  const [samples, setSamples] = useState<Chapter[]>([]);
  const [sampleError, setSampleError] = useState('');
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [removedTitle, setRemovedTitle] = useState('');

  useEffect(() => {
    let active = true;
    setListBusy(true); setListError('');
    api<{ works: WorkOption[] }>(`/api/admin/works?q=${encodeURIComponent(query)}`)
      .then((data) => { if (active) setWorks(data.works); })
      .catch(() => { if (active) setListError(t('無法載入作品。請重新整理頁面再試。')); })
      .finally(() => { if (active) setListBusy(false); });
    return () => { active = false; };
  }, [query, refresh, refreshVersion]);

  useEffect(() => {
    let active = true;
    setPreview(null); setDraft(null); setChapterId(''); setChapter(null); setShowChapter(false); setSamples([]); setMsg(''); setOk(false);
    if (!workId) { setBusy(false); return; }
    setBusy(true);
    Promise.all([
      getPublishPreview(workId),
      api<Draft>(`/api/admin/preview/works/${workId}/chapters`),
    ]).then(([result, content]) => {
      if (!active) return;
      setPreview(result); setDraft(content); setChapterId(content.chapters[0]?.id ?? '');
    }).catch(() => {
      if (active) setMsg(t('無法載入草稿。請重新選擇作品，或按「重新載入」。'));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [workId, refresh, refreshVersion]);

  useEffect(() => {
    let active = true;
    setChapter(null); setChapterError('');
    if (!chapterId || !showChapter) return;
    api<Chapter>(`/api/admin/preview/works/${workId}/chapters/${chapterId}`)
      .then((data) => { if (active) setChapter(data); })
      .catch(() => { if (active) setChapterError(t('無法讀取此章內容，請重新載入草稿再試。')); });
    return () => { active = false; };
  }, [workId, chapterId, refresh, showChapter]);

  useEffect(() => {
    let active = true;
    setSamples([]); setSampleError('');
    if (!draft?.chapters.length) return;
    const indices = [...new Set([0, Math.floor(draft.chapters.length / 2), draft.chapters.length - 1])];
    Promise.all(indices.map((index) => api<Chapter>(`/api/admin/preview/works/${workId}/chapters/${draft.chapters[index].id}`)))
      .then((items) => { if (active) setSamples(items.map((item) => ({ ...item, body: item.body.slice(0, 240) }))); })
      .catch(() => { if (active) setSampleError(t('抽樣內容暫時無法載入，可重新載入或展開完整預覽。')); });
    return () => { active = false; };
  }, [draft, workId]);

  const doPublish = async (afterSave = false) => {
    if (busy || !preview || preview.workId !== workId || (!afterSave && !preview.valid)) return;
    setBusy(true); setMsg(''); setOk(false);
    try {
      const result = await publishWork(workId, `ui-publish-${workId}-${Date.now()}`);
      // Keep the successful publication visible even if the subsequent preview refresh fails.
      setPreview((current) => current && { ...current, valid: true, problems: [],
        previousRelease: { id: result.releaseId, version: result.version, chapterCount: result.chapterCount },
        diff: { newChapterIds: [], updatedChapterIds: [], reorderedChapterIds: [], removedChapterIds: [] },
      });
      setOk(true);
      setMsg(t('已發布 v{version}，共 {n} 章。讀者現在可以閱讀這個版本。', { version: result.version, n: count(result.chapterCount) }));
      onPublished?.();
    } catch (e) {
      const err = e as { code?: string; body?: { problems?: string[] } };
      setMsg(err.code === 'publish_validation_failed'
        ? t('發布前檢查未通過：{problems}。請修正來源並重新匯入。', { problems: err.body?.problems?.map(problemText).join('、') ?? '' })
        : t('發布失敗。草稿已保留，請重新載入檢查後再試。'));
    } finally { setBusy(false); }
  };

  const removeWork = async () => {
    if (busy || !draft) return;
    const title = draft.work.title;
    if (!confirm(t('刪除《{title}》？作品會從書庫及管理清單移除，讀者將無法開啟。系統會保留內容及閱讀紀錄。', { title }))) return;
    setBusy(true); setMsg(''); setOk(false);
    try {
      await api(`/api/admin/works/${workId}`, { method: 'DELETE' });
      setWorks((items) => items.filter((item) => item.id !== workId));
      setRemovedTitle(title);
      onWorkChange('');
      setRefresh((value) => value + 1);
    } catch {
      setMsg(t('刪除失敗。請重新載入作品後再試。'));
    } finally { setBusy(false); }
  };

  const chapterIndex = draft?.chapters.findIndex((item) => item.id === chapterId) ?? -1;
  const hasChanges = !!preview && (!preview.previousRelease ||
    preview.diff.newChapterIds.length + preview.diff.updatedChapterIds.length + preview.diff.reorderedChapterIds.length + (preview.diff.removedChapterIds?.length ?? 0) > 0);

  const needsSetup = !!preview?.problems.some((problem) => ['title_required', 'serial_status_required', 'category_required_for_first_publication'].includes(problem));
  const contentBlocked = !!preview?.problems.some((problem) => !['title_required', 'serial_status_required', 'category_required_for_first_publication'].includes(problem));

  return (
    <section className="admin-panel admin-publish" data-testid="publish-panel">
      <h2>{t('草稿與發布')}</h2>
      <p className="muted">{t('確認作品資料及章數即可發布。系統會檢查內容是否齊全，抽查文字是可選操作。')}</p>
      {!workId && removedTitle && <p className="form-ok" role="status">{t('已刪除《{title}》，讀者已無法開啟。', { title: removedTitle })}</p>}
      <details open={!workId}><summary>{t('選擇其他作品')}</summary>
      <div className="field">
        <label htmlFor="publish-search">{t('搜尋作品名稱或作者')}</label>
        <input className="input" id="publish-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="hint">{t('顯示最新 50 部符合搜尋的作品；找不到時請輸入更完整的名稱。')}</span>
      </div>
      {listError && <p className="form-error" role="alert">{listError}</p>}
      <div className="field">
        <label htmlFor="publish-work">{t('選擇作品')}</label>
        <select className="input" id="publish-work" value={workId} disabled={busy}
          onChange={(e) => onWorkChange(e.target.value)}>
          <option value="">{t('請選擇作品')}</option>
          {workId && !works.some((w) => w.id === workId) && <option value={workId}>{draft?.work.title ?? t('指定作品')}</option>}
          {works.map((work) => <option key={work.id} value={work.id}>
            {work.title}{work.author ? `／${work.author}` : ''} · {work.activeReleaseId ? t('已有發布版本') : t('尚未發布')}
          </option>)}
        </select>
      </div>
      </details>
      {listBusy && <p className="hint" role="status">{t('載入作品中…')}</p>}
      {!listBusy && !listError && !works.length && <p className="hint">{query ? t('沒有符合搜尋的作品。請修改關鍵字。') : t('尚未有作品。請先在「匯入」建立草稿。')}</p>}
      <div className="row-actions">
        <button className="btn" onClick={() => setRefresh((value) => value + 1)} disabled={busy}>{t('重新載入')}</button>
        {draft && <button className="btn" onClick={() => void removeWork()} disabled={busy}>{t('刪除作品')}</button>}
      </div>
      {busy && <p className="hint" role="status">{draft ? t('發布中…') : t('載入草稿及發布檢查…')}</p>}
      {msg && <p className={ok ? 'form-ok' : 'form-error'} role="status">{msg}</p>}
      {ok && <div className="row-actions">
        <button className="btn primary" onClick={() => navigate(`/read/${workId}`)}>{t('閱讀已發布作品')}</button>
        <button className="btn" onClick={() => navigate(`/works/${workId}`)}>{t('查看作品頁')}</button>
      </div>}
      <div className="publish-summary">
      {draft && <div className="publish-work-summary">
        <h3>{draft.work.title}</h3>
        <dl className="meta-grid">
          <dt>{t('作者')}</dt><dd>{draft.work.author || t('未填寫')}</dd>
          <dt>{t('狀態')}</dt><dd>{t(({ ongoing: '未完結', completed: '完結', paused: '暫停連載' } as Record<string, string>)[draft.work.serialStatus ?? ''] ?? '未設定')}</dd>
          <dt>{t('簡介')}</dt><dd className="draft-description">{draft.work.description || t('未填寫')}</dd>
        </dl>
        <details open={needsSetup}>
          <summary>{needsSetup ? t('補齊發布所需資料') : t('修改作品資料與分類（可選）')}</summary>
          <DraftSettings key={workId} workId={workId} work={draft.work} publishOnSave={needsSetup && !contentBlocked}
            onSaved={async (publish) => {
              if (publish) {
                const content = await api<Draft>(`/api/admin/preview/works/${workId}/chapters`);
                setDraft(content);
                await doPublish(true);
              } else setRefresh((value) => value + 1);
            }} />
        </details>
      </div>}
      {preview && <div className="publish-checks">
        <h3>{t('發布前檢查')}</h3>
        <dl className="meta-grid">
          <dt>{t('草稿章數')}</dt><dd>{t('{n} 章', { n: count(preview.chapterCount) })}</dd>
          <dt>{t('目前公開')}</dt><dd>{preview.previousRelease
            ? t('v{version}（{n} 章）', { version: preview.previousRelease.version, n: count(preview.previousRelease.chapterCount) })
            : t('尚未發布')}</dd>
        </dl>
        <div className="tally">
          <div><b>{preview.diff.newChapterIds.length}</b>{t('新章')}</div>
          <div><b>{preview.diff.updatedChapterIds.length}</b>{t('修訂章')}</div>
          <div><b>{preview.diff.reorderedChapterIds.length}</b>{t('重排章')}</div>
          <div><b>{preview.diff.removedChapterIds?.length ?? 0}</b>{t('刪除章')}</div>
        </div>
        {preview.valid ? <>
          <p className={hasChanges ? 'form-ok' : 'hint'}>{hasChanges ? t('發布檢查通過。確認後，讀者會看到以上草稿內容。') : t('目前沒有待發布的章節變更。')}</p>
          <button className="btn primary btn-block" onClick={() => void doPublish()} disabled={busy || !hasChanges} aria-busy={busy || undefined}>
            {busy ? t('發布中…') : t('確認發布，讓讀者閱讀')}
          </button>
        </> : <p className="form-error" role="alert">{t('無法發布：{problems}。請先補齊上方作品資料及分類；內容問題則需修正來源再匯入。', { problems: preview.problems.map(problemText).join('、') })}</p>}
      </div>}
      </div>
      {draft && <details>
        <summary>{t('抽樣文字：開頭、中段、結尾（可選）')}</summary>
        <p className="hint">{t('每處顯示最多 240 字，方便確認編碼與分段。')}</p>
        {sampleError ? <p className="form-warn">{sampleError}</p> : samples.length ? samples.map((item) =>
          <section key={item.chapterId}><h3>{item.labelRaw} {item.title || t('（無標題）')}</h3>
            <p className="draft-description">{item.body || t('（沒有內容）')}</p></section>) : <p className="hint">{t('載入抽樣內容中…')}</p>}
      </details>}
      {draft && <>
        {draft.chapters.length > 0 ? <details onToggle={(e) => setShowChapter(e.currentTarget.open)}>
          <summary>{t('完整章節預覽（可選）')}</summary>
          <div className="field">
            <label htmlFor="draft-chapter">{t('預覽章節')}</label>
            <select className="input" id="draft-chapter" value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
              {draft.chapters.map((item, index) => <option key={item.id} value={item.id}>
                {index + 1}. {item.labelRaw} {item.title || t('（無標題）')}
              </option>)}
            </select>
          </div>
          <div className="row-actions pager">
            <button className="btn" disabled={chapterIndex <= 0} onClick={() => setChapterId(draft.chapters[chapterIndex - 1].id)}>{t('上一章')}</button>
            <span className="hint">{chapterIndex + 1} / {t('{n} 章', { n: count(draft.chapters.length) })}</span>
            <button className="btn" disabled={chapterIndex < 0 || chapterIndex >= draft.chapters.length - 1}
              onClick={() => setChapterId(draft.chapters[chapterIndex + 1].id)}>{t('下一章')}</button>
          </div>
          {chapterError ? <p className="form-error" role="alert">{chapterError}</p> : chapter ?
            <article className="draft-body" aria-label={t('草稿章節內容')}>{chapter.body || t('（本章沒有內容）')}</article> :
            <p className="hint" role="status">{t('載入章節內容…')}</p>}
        </details> : <p className="form-warn">{t('草稿沒有章節，請先匯入內容。')}</p>}
      </>}
    </section>
  );
}

function problemText(problem: string): string {
  const messages: Record<string, string> = {
    title_required: '請填寫作品名稱', serial_status_required: '請選擇連載狀態',
    category_required_for_first_publication: '請選擇至少一個有效分類', no_chapters: '作品尚未有章節',
    work_removed: '作品已移除，不能發布', invalid_work_type: '作品類型不正確', work_not_found: '找不到作品',
  };
  if (messages[problem]) return t(messages[problem]);
  if (problem.endsWith('_chapters_missing_revision')) return t('部分章節缺少修訂內容');
  if (problem.endsWith('_content_objects_missing')) return t('部分章節正文遺失，請重新匯入');
  if (problem.endsWith('_resource_objects_missing')) return t('部分章節圖片遺失，請重新匯入');
  return t('檢查未通過（{problem}）', { problem });
}

function DraftSettings({ workId, work, onSaved, publishOnSave }: { workId: string; work: Draft['work']; publishOnSave: boolean; onSaved(publish: boolean): Promise<void> }) {
  const [title, setTitle] = useState(work.title);
  const [author, setAuthor] = useState(work.author);
  const [description, setDescription] = useState(work.description);
  const [status, setStatus] = useState(work.serialStatus ?? '');
  const [selection, setSelection] = useState<TaxonomySelection>({ categoryIds: [], tagIds: [] });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<{ categoryIds: string[]; tagIds: string[] }>(`/api/admin/works/${workId}/taxonomy`)
      .then((assignment) => {
        if (!active) return;
        setSelection({ categoryIds: assignment.categoryIds, tagIds: assignment.tagIds });
        setLoaded(true);
      }).catch(() => { if (active) setError(t('無法載入分類與標籤，請按「重新載入」再試。')); });
    return () => { active = false; };
  }, [workId]);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      await api(`/api/admin/works/${workId}`, json('PATCH', { title, author, description, serialStatus: status || null }));
      await api(`/api/admin/works/${workId}/taxonomy`, json('PUT', selection));
      await onSaved(publishOnSave);
    } catch { setError(t('未能儲存全部資料。請重新載入，確認已儲存的內容後再試。')); }
    finally { setBusy(false); }
  }
  return <>
    <h3>{t('補齊作品資料與分類')}</h3>
    <p className="hint">{t('發布前需要作品名稱、長篇的連載狀態及至少一個分類。作品資料與分類儲存後立即生效；章節內容需另外確認發布。')}</p>
    <form className="form-grid draft-settings" onSubmit={save}>
      <div className="field"><label htmlFor="draft-title">{t('作品名稱（必填）')}</label>
        <input className="input" id="draft-title" value={title} required maxLength={300} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label htmlFor="draft-author">{t('作者')}</label>
        <input className="input" id="draft-author" value={author} maxLength={300} onChange={(e) => setAuthor(e.target.value)} /></div>
      <div className="field field-wide"><label htmlFor="draft-description">{t('簡介')}</label>
        <textarea className="input" id="draft-description" rows={3} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} /></div>
      {work.workType === 'serial' && <div className="field"><label htmlFor="draft-status">{t('連載狀態（必填）')}</label>
        <select className="input" id="draft-status" value={status} required onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('請選擇')}</option><option value="ongoing">{t('未完結')}</option>
          <option value="completed">{t('完結')}</option><option value="paused">{t('暫停連載')}</option>
        </select></div>}
      <fieldset className="draft-categories"><legend>{t('分類（至少一個，最多五個）與標籤')}</legend>
        {!loaded ? <p className="hint">{t('載入分類與標籤中…')}</p>
          : <TaxonomyPicker idPrefix="draft" value={selection} onChange={setSelection} disabled={busy} />}
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn" disabled={busy || !loaded || !selection.categoryIds.length}>{busy ? t('儲存中…') : publishOnSave ? t('儲存並發布') : t('儲存資料')}</button>
    </form>
  </>;
}
