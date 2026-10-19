import { useRef, useState, type DragEvent } from 'react';
import { api, getPublishPreview, publishWork } from '../api/client.ts';
import { useImportMonitor } from './useImportMonitor.ts';
import type { ImportJob, ImportQuality } from '../api/import-types.ts';
import { count } from '../lib/format.ts';
import { DEFAULT_TIDY_OPTIONS, tidyTxt, type TidyOptions, type TidyResult } from './tidy-txt.ts';
import { TaxonomyPicker, type TaxonomySelection } from './TaxonomyPicker.tsx';
import { t } from '../i18n/translate.ts';

type Quality = ImportQuality;
type RulePreset = { name: string; encoding: string; chapterPattern: string; tidy: TidyOptions };
type Preview = TidyResult & { original: string };
type Row = {
  key: number; file: File; originalFile: File; selected: boolean; status: string;
  importId?: string; title: string; author: string; description: string;
  workType: 'serial' | 'short_story'; serialStatus: '' | 'ongoing' | 'completed';
  encodingResult?: NonNullable<ImportJob['encodingResult']>;
  chapterCount?: number; quality?: Quality; error?: string; workId?: string;
  publishProblems?: string[]; publishedVersion?: number; cleaned?: boolean;
  /** undefined = follow the batch default; set = this book overrides it */
  taxonomy?: TaxonomySelection;
  keywords?: string[];
};

const NO_TAXONOMY: TaxonomySelection = { categoryIds: [], tagIds: [] };

const STORE_KEY = 'ebook-import-rule-presets-v1';
// source strings; translated at the render sites below
const encodings = [
  ['', '自動偵測'], ['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['big5', 'Big5'], ['gb18030', 'GB18030'],
];
const labels: Record<string, string> = {
  waiting: '待上傳', uploading: '上傳中', queued: '排隊中', processing: '解析中',
  ready: '解析完成', review_required: '解析完成，有提示', failed: '失敗',
  committed: '草稿已儲存', published: '已發布',
};
const tone: Record<string, string> = {
  uploading: 'state-busy', queued: 'state-busy', processing: 'state-busy',
  ready: 'state-ok', published: 'state-ok', committed: 'state-review', review_required: 'state-review', failed: 'state-bad',
};

function readPresets(): RulePreset[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.name === 'string') : [];
  } catch { return []; }
}

function selectedFiles(files: FileList | File[]): File[] {
  return [...files].filter((file) => /\.(txt|epub)$/i.test(file.name)).slice(0, 10);
}

function State({ status }: { status: string }) {
  return <span className={`state ${tone[status] ?? ''}`}>{labels[status] ? t(labels[status]) : status}</span>;
}

function issueLocations(issue: Quality['issues'][number]): string {
  return issue.positions.map((position, index) => (issue.labels[index]
    ? t('第 {n} 項（{label}）', { n: position + 1, label: issue.labels[index] })
    : t('第 {n} 項', { n: position + 1 }))).join('、');
}

export function BatchImportPanel({ onBack, onOpenWork }: { onBack(): void; onOpenWork(workId: string): void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [presets, setPresets] = useState<RulePreset[]>(readPresets);
  const [presetName, setPresetName] = useState('');
  const [presetIndex, setPresetIndex] = useState('');
  const [encoding, setEncoding] = useState('');
  const [chapterPattern, setChapterPattern] = useState('');
  const [tidy, setTidy] = useState<TidyOptions>(DEFAULT_TIDY_OPTIONS);
  const [previews, setPreviews] = useState<Record<number, Preview | string>>({});
  const [batchTaxonomy, setBatchTaxonomy] = useState<TaxonomySelection>(NO_TAXONOMY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const monitor = useImportMonitor((id, { job, quality, error }) => {
    setRows((current) => current.map((item) => {
      if (item.importId !== id) return item;
      const metadata = job?.encodingResult?.metadata;
      return {
        ...item,
        status: ['committed', 'published'].includes(item.status) ? item.status : job?.status ?? item.status,
        chapterCount: job?.chapterCount ?? item.chapterCount,
        encodingResult: job?.encodingResult ?? item.encodingResult,
        quality: quality ?? item.quality,
        error: job?.status === 'failed'
          ? `${job.errorCode ?? t('解析失敗')}${job.errorDetail ? `：${job.errorDetail}` : ''}`
          : error ?? undefined,
        title: item.title === item.originalFile.name.replace(/\.(txt|epub)$/i, '') ? metadata?.title || item.title : item.title,
        author: item.author || metadata?.author || '',
        description: item.description || metadata?.description || '',
        serialStatus: item.serialStatus || metadata?.serialStatus || '',
        keywords: metadata?.keywords ?? item.keywords,
      };
    }));
  });

  const appendFiles = (files: FileList | File[]) => {
    const accepted = selectedFiles(files);
    if (!accepted.length) { setMessage(t('請選擇 TXT 或 EPUB 檔案。')); return; }
    const next = accepted.map((file, index): Row => ({
      key: Date.now() + index, file, originalFile: file, selected: true, status: 'waiting',
      title: file.name.replace(/\.(txt|epub)$/i, ''), author: '', description: '',
      workType: 'serial', serialStatus: '',
    }));
    setRows((current) => [...current, ...next]);
    setPreviews({}); setMessage(accepted.length < files.length ? t('每次最多加入 10 個 TXT／EPUB 檔案。') : '');
  };
  const update = (key: number, patch: Partial<Row>) => setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  // A row follows the batch default until it is given its own selection.
  const taxonomyFor = (row: Row): TaxonomySelection => row.taxonomy ?? batchTaxonomy;

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const next = [...presets.filter((item) => item.name !== name), { name, encoding, chapterPattern, tidy }].slice(-10);
    setPresets(next); localStorage.setItem(STORE_KEY, JSON.stringify(next));
    setPresetIndex(name); setPresetName(''); setMessage(t('已儲存「{name}」匯入規則。', { name }));
  };
  const loadPreset = (name: string) => {
    setPresetIndex(name);
    const preset = presets.find((item) => item.name === name);
    if (!preset) { setEncoding(''); setChapterPattern(''); setTidy(DEFAULT_TIDY_OPTIONS); return; }
    setEncoding(preset.encoding); setChapterPattern(preset.chapterPattern); setTidy(preset.tidy);
    setPreviews({});
  };

  const previewTidy = async (row: Row) => {
    setPreviews((current) => ({ ...current, [row.key]: t('讀取檔案中…') }));
    try {
      const original = new TextDecoder(encoding || 'utf-8', { fatal: true }).decode(await row.file.arrayBuffer());
      const result = tidyTxt(original, tidy);
      setPreviews((current) => ({ ...current, [row.key]: { ...result, original } }));
    } catch {
      setPreviews((current) => ({ ...current, [row.key]: t('無法使用目前選定的編碼讀取。請更改編碼後重試預覽。') }));
    }
  };
  const applyTidy = (row: Row, preview: Preview) => {
    const file = new File([preview.text], row.file.name, { type: 'text/plain', lastModified: Date.now() });
    update(row.key, { file, cleaned: true });
    setMessage(t('已套用「{name}」的整理結果；原檔仍保留在本機選取狀態。', { name: row.file.name }));
  };

  const uploadWaiting = async () => {
    const waiting = rows.filter((row) => !row.importId && ['waiting', 'failed'].includes(row.status));
    if (!waiting.length) return;
    setBusy(true); setMessage('');
    for (const row of waiting) {
      update(row.key, { status: 'uploading', error: undefined });
      try {
        const form = new FormData();
        form.append('file', row.file);
        if (row.cleaned) form.append('encoding', 'utf-8');
        else if (encoding) form.append('encoding', encoding);
        if (chapterPattern.trim() && /\.txt$/i.test(row.file.name)) form.append('chapterPattern', chapterPattern.trim());
        const result = await api<{ importId: string }>('/api/admin/imports', { method: 'POST', body: form });
        update(row.key, { importId: result.importId, status: 'queued' });
        monitor.watch(result.importId);
      } catch (error) {
        update(row.key, { status: 'failed', error: error instanceof Error ? error.message : t('上傳失敗') });
      }
    }
    setBusy(false);
  };

  const retryParse = async (row: Row) => {
    if (!row.importId || busy) return;
    setBusy(true);
    monitor.stop(row.importId);
    try {
      await api(`/api/admin/imports/${row.importId}/reanalyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ encoding: row.cleaned ? 'utf-8' : encoding, chapterPattern: chapterPattern.trim() }),
      });
      update(row.key, { status: 'queued', error: undefined, quality: undefined, publishProblems: undefined });
    } catch (error) {
      update(row.key, { status: 'failed', error: error instanceof Error ? error.message : t('重新解析失敗') });
    } finally { monitor.watch(row.importId); setBusy(false); }
  };

  const commitAndPublish = async () => {
    const selected = rows.filter((row) => row.selected && row.importId &&
      ['ready', 'review_required', 'committed'].includes(row.status));
    if (!selected.length || unclassified.length) return;
    setBusy(true); setMessage('');
    const prepared: Array<{ row: Row; workId: string }> = [];
    for (const row of selected) {
      monitor.stop(row.importId);
      const { categoryIds, tagIds } = taxonomyFor(row);
      try {
        let workId = row.workId;
        const created = !workId;
        if (!workId) {
          // commit assigns the taxonomy in the same transaction — the draft is
          // never briefly present and unclassified
          const result = await api<{ workId: string }>(`/api/admin/imports/${row.importId}/commit`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: row.title.trim() || t('未命名作品'), workType: row.workType,
              author: row.author, description: row.description,
              serialStatus: row.workType === 'serial' ? row.serialStatus || null : null,
              categoryIds, tagIds }),
          });
          workId = result.workId;
          update(row.key, { workId, status: 'committed', error: undefined });
        }
        await api(`/api/admin/works/${workId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: row.title.trim() || t('未命名作品'), author: row.author, description: row.description,
            workType: row.workType,
            serialStatus: row.workType === 'serial' ? row.serialStatus || null : null }) });
        // Re-running an already-committed row: the assignment is a replace-set,
        // so only send what this row actually shows as selected.
        if (!created) {
          await api(`/api/admin/works/${workId}/taxonomy`, { method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ categoryIds, tagIds }) });
        }
        prepared.push({ row, workId });
      } catch (error) {
        update(row.key, { status: row.workId ? 'committed' : row.status,
          error: error instanceof Error ? error.message : t('建立草稿失敗') });
      }
    }

    const checks = await Promise.all(prepared.map(async (entry) => {
      try {
        const preview = await getPublishPreview(entry.workId);
        if (!preview.valid) {
          update(entry.row.key, { status: 'committed', publishProblems: preview.problems,
            error: t('發布檢查未通過：{problems}', { problems: preview.problems.join('、') }) });
          return null;
        }
        return entry;
      } catch (error) {
        update(entry.row.key, { status: 'committed', error: error instanceof Error ? error.message : t('發布檢查失敗') });
        return null;
      }
    }));
    await Promise.all(checks.filter((entry): entry is NonNullable<typeof entry> => !!entry).map(async ({ row, workId }) => {
      try {
        const result = await publishWork(workId, `ui-batch-${row.importId}-${Date.now()}`);
        update(row.key, { status: 'published', workId, publishedVersion: result.version, error: undefined, publishProblems: [] });
      } catch (error) {
        update(row.key, { status: 'committed', workId, error: error instanceof Error ? error.message : t('發布失敗；草稿已保留') });
      }
    }));
    setBusy(false);
  };

  const readyRows = rows.filter((row) => row.selected && row.importId && ['ready', 'review_required', 'committed'].includes(row.status));
  const readyCount = readyRows.length;
  const uploadCount = rows.filter((row) => !row.importId && ['waiting', 'failed'].includes(row.status)).length;
  const unclassified = readyRows.filter((row) => !taxonomyFor(row).categoryIds.length);

  const drag = (event: DragEvent) => { event.preventDefault(); setDragging(true); };
  return (
    <section className="admin-panel batch-import" data-testid="batch-import">
      <div className="head-line"><h2>{t('批量匯入')}</h2><button className="linkish" onClick={onBack}>{t('返回單本匯入')}</button></div>
      <p className="muted">{t('一次加入多本 TXT／EPUB。確認各本的資料與異常摘要後，可建立草稿並批量發布；不必逐章預覽。')}</p>

      <details className="admin-sub">
        <summary>{t('匯入規則預設')}</summary>
        <div className="field">
          <label htmlFor="batch-rule">{t('已儲存的規則')}</label>
          <select className="input" id="batch-rule" value={presetIndex} onChange={(event) => loadPreset(event.target.value)}>
            <option value="">{t('內建辨識規則')}</option>
            {presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}
          </select>
          {presetIndex && <button className="btn" onClick={() => {
            const remaining = presets.filter((preset) => preset.name !== presetIndex);
            setPresets(remaining); localStorage.setItem(STORE_KEY, JSON.stringify(remaining)); loadPreset('');
          }}>{t('刪除此預設')}</button>}
        </div>
        <div className="field">
          <label htmlFor="batch-encoding">{t('文字編碼')}</label>
          <select className="input" id="batch-encoding" value={encoding} onChange={(event) => setEncoding(event.target.value)}>
            {encodings.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="batch-heading-pattern">{t('自訂章節標題規則（正規表示式）')}</label>
          <input className="input input-mono" id="batch-heading-pattern" value={chapterPattern}
            placeholder={t('留空使用內建繁簡章回辨識')} maxLength={200} onChange={(event) => setChapterPattern(event.target.value)} />
          <span className="hint">{t('只用於 TXT；規則需匹配獨立章名行，請在本機先保存常用來源格式。')}</span>
        </div>
        <fieldset className="batch-rule-options">
          <legend>{t('TXT 整理選項')}</legend>
          {([
            ['trimLines', '清除每行前後空白'], ['collapseBlankLines', '合併連續空白行'],
            ['removePromotions', '移除明確網站廣告行'], ['joinWrappedLines', '合併疑似錯誤斷行'],
          ] as const).map(([key, label]) => <label className="check-line" key={key}>
            <input type="checkbox" checked={tidy[key]} onChange={(event) => {
              setTidy((current) => ({ ...current, [key]: event.target.checked })); setPreviews({});
            }} />{t(label)}
          </label>)}
        </fieldset>
        <div className="form-row">
          <input className="input" value={presetName} maxLength={40} placeholder={t('預設名稱，例如：來源 A')} aria-label={t('新預設名稱')}
            onChange={(event) => setPresetName(event.target.value)} />
          <button className="btn" onClick={savePreset} disabled={!presetName.trim()}>{t('儲存目前規則')}</button>
        </div>
        <p className="hint">{t('規則只保存在這個瀏覽器；章節辨識預設接受獨立標題行，不會改寫上傳原文。')}</p>
      </details>

      <div className={`batch-drop${dragging ? ' is-dragging' : ''}`} onDragOver={drag} onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); appendFiles(event.dataTransfer.files); }}>
        <input ref={fileInput} className="input" type="file" accept=".txt,.epub" multiple
          aria-label={t('選擇多個 TXT 或 EPUB 檔案')} onChange={(event) => {
            if (event.target.files) appendFiles(event.target.files); event.target.value = '';
          }} />
        <span className="hint">{t('可拖放檔案至此；每次最多加入 10 個。TXT 上限 30 MiB，EPUB 上限 50 MiB。')}</span>
      </div>

      {!!rows.length && <>
        <div className="row-actions">
          <button className="btn primary" disabled={busy || !uploadCount} onClick={() => void uploadWaiting()}>
            {busy ? t('處理中…') : t('上傳並解析 {n} 本', { n: uploadCount })}
          </button>
          <button className="btn primary" disabled={busy || !readyCount || !!unclassified.length} onClick={() => void commitAndPublish()}>
            {t('建立草稿並批量發布 {n} 本', { n: readyCount })}
          </button>
        </div>
        <div className="field">
          <span className="field-label">{t('批量指派分類與標籤（發布必需至少一個分類）')}</span>
          <span className="hint">{t('這裡選的套用到所有未自訂的書；個別書可在下方「分類與標籤」覆寫。')}</span>
          <TaxonomyPicker idPrefix="batch" value={batchTaxonomy} onChange={setBatchTaxonomy} disabled={busy} />
        </div>
        {!!unclassified.length && <p className="form-warn" role="status">
          {t('還有 {n} 本未指定分類：{names}。指定批量分類，或逐本在「分類與標籤」選擇。', {
            n: unclassified.length, names: unclassified.map((row) => row.file.name).join('、'),
          })}
        </p>}
        <ol className="batch-list">
          {rows.map((row) => {
            const preview = previews[row.key];
            const isTxt = /\.txt$/i.test(row.file.name);
            return <li key={row.key} className="batch-row">
              <div className="batch-row-head">
                <label className="check-line"><input type="checkbox" checked={row.selected}
                  onChange={(event) => update(row.key, { selected: event.target.checked })} />
                  <span className="batch-filename">{row.file.name}</span></label>
                <State status={row.status} />
              </div>
              {row.chapterCount !== undefined && <p className="hint">{t('辨識 {n} 章', { n: count(row.chapterCount) })}　·　{row.encodingResult?.metadata?.title ? t('識別作品名：{title}', { title: row.encodingResult.metadata.title }) : ''}</p>}
              {row.cleaned && <p className="form-ok">{t('已套用文字整理預覽')}</p>}
              {row.quality && <div className={row.quality.issueCount ? 'form-warn' : 'form-ok'}>
                <p>{t('章節檢查：{total} 項；空章 {empty}、重複章 {duplicates}、跳號 {gaps}。', {
                  total: row.quality.total, empty: row.quality.counts.empty,
                  duplicates: row.quality.counts.duplicates, gaps: row.quality.counts.gaps,
                })}</p>
                {row.quality.issues.length > 0 && <ul>{row.quality.issues.slice(0, 20).map((issue, index) =>
                  <li key={`${issue.type}-${index}`}>{issue.message}：{issueLocations(issue)}</li>)}</ul>}
              </div>}
              {row.encodingResult?.warnings?.map((warning, index) => <p className="form-warn" key={index}>{warning}</p>)}
              {row.error && <p className="form-error" role="alert">{row.error}</p>}
              {row.importId && row.status === 'failed' && <button className="btn" disabled={busy}
                onClick={() => void retryParse(row)}>{t('依目前規則重新解析')}</button>}
              {row.publishProblems?.length ? <ul className="form-warn">{row.publishProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
              {row.workId && <p className="hint">{t('作品 ID：')}<span className="mono">{row.workId}</span>
                {row.publishedVersion ? `　${t('已發布 v{version}', { version: row.publishedVersion })}` : ''}
                <button className="linkish" onClick={() => onOpenWork(row.workId!)}>{t('開啟草稿管理')}</button></p>}
              {row.importId && ['ready', 'review_required', 'committed', 'published'].includes(row.status) && <details>
                <summary>{t('作品資料')} {row.status === 'published' ? t('（已發布）') : t('（可修改）')}</summary>
                <div className="batch-metadata">
                  <div className="field"><label htmlFor={`batch-title-${row.key}`}>{t('作品名稱')}</label>
                    <input className="input" id={`batch-title-${row.key}`} value={row.title} disabled={row.status === 'published'}
                      onChange={(event) => update(row.key, { title: event.target.value })} /></div>
                  <div className="field"><label htmlFor={`batch-author-${row.key}`}>{t('作者')}</label>
                    <input className="input" id={`batch-author-${row.key}`} value={row.author} disabled={row.status === 'published'}
                      onChange={(event) => update(row.key, { author: event.target.value })} /></div>
                  <div className="field"><label htmlFor={`batch-type-${row.key}`}>{t('作品類型')}</label>
                    <select className="input" id={`batch-type-${row.key}`} value={row.workType} disabled={row.status === 'published'}
                      onChange={(event) => update(row.key, { workType: event.target.value as Row['workType'] })}>
                      <option value="serial">{t('長篇連載')}</option><option value="short_story">{t('短篇小說')}</option>
                    </select></div>
                  <div className="field"><label htmlFor={`batch-status-${row.key}`}>{t('連載狀態')}</label>
                    <select className="input" id={`batch-status-${row.key}`} value={row.serialStatus}
                      disabled={row.workType !== 'serial' || row.status === 'published'} onChange={(event) => update(row.key, { serialStatus: event.target.value as Row['serialStatus'] })}>
                      <option value="">{t('待確認')}</option><option value="ongoing">{t('未完結')}</option><option value="completed">{t('完結')}</option>
                    </select></div>
                  <div className="field field-wide"><label htmlFor={`batch-description-${row.key}`}>{t('簡介')}</label>
                    <textarea className="input" id={`batch-description-${row.key}`} rows={3} value={row.description} disabled={row.status === 'published'}
                      onChange={(event) => update(row.key, { description: event.target.value })} /></div>
                  <div className="field field-wide">
                    <span className="field-label">{t('分類與標籤')}</span>
                    <p className="hint">
                      {row.taxonomy
                        ? t('這本使用自訂指派。')
                        : t('這本跟隨上方的批量指派；改動下列任何一項即成為自訂。')}
                      {row.taxonomy && <button className="linkish" disabled={row.status === 'published'}
                        onClick={() => update(row.key, { taxonomy: undefined })}>{t('改回跟隨批量指派')}</button>}
                    </p>
                    <TaxonomyPicker compact idPrefix={`batch-${row.key}`} keywords={row.keywords}
                      value={taxonomyFor(row)} disabled={row.status === 'published'}
                      onChange={(next) => update(row.key, { taxonomy: next })} />
                  </div>
                </div>
              </details>}
              {isTxt && !row.importId && <details>
                <summary>{t('TXT 文字整理預覽')}</summary>
                <p className="hint">{t('整理只影響本次待上傳副本。預設只修整空白；廣告移除及斷行合併需勾選，並由你先檢視再套用。')}</p>
                <button className="btn" disabled={row.status === 'uploading'} onClick={() => void previewTidy(row)}>{t('產生前後預覽')}</button>
                {typeof preview === 'string' && <p className="form-error" role="alert">{preview}</p>}
                {preview && typeof preview !== 'string' && <>
                  <p className="hint">{t('修整 {trimmed} 行空白、合併 {collapsed} 個多餘空行、移除 {ads} 行廣告、合併 {joined} 次斷行。', {
                    trimmed: preview.trimmedLines, collapsed: preview.collapsedBlankLines,
                    ads: preview.removedPromotionLines, joined: preview.joinedLines,
                  })}</p>
                  <div className="tidy-preview"><div><h3>{t('原文')}</h3><pre>{preview.original.slice(0, 2400)}</pre></div>
                    <div><h3>{t('整理後')}</h3><pre>{preview.text.slice(0, 2400)}</pre></div></div>
                  {preview.original.length > 2400 && <p className="hint">{t('預覽各顯示前 2,400 字；套用時會處理全文。')}</p>}
                  <button className="btn" onClick={() => applyTidy(row, preview)}>{t('套用整理後文字')}</button>
                </>}
              </details>}
            </li>;
          })}
        </ol>
      </>}
      {message && <p className="hint" role="status">{message}</p>}
      {!rows.length && <p className="hint">{t('加入檔案後，會逐本顯示解析進度與章節品質摘要。')}</p>}
    </section>
  );
}
