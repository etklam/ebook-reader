import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';

type ChapterRow = {
  id: string;
  labelRaw: string;
  title: string | null;
  editorialPosition: number;
  revisionId: string | null;
};
type ChapterDetail = {
  chapterId: string;
  workId: string;
  labelRaw: string;
  revisionId: string;
  title: string;
  body: string;
  updatedAt: string;
  history: Array<{ revisionId: string; title: string; createdAt: string; sourceImportId: string | null }>;
};

function errorText(code: string): string {
  const messages: Record<string, string> = {
    stale_chapter_revision: '章節剛被其他操作更新，請重新載入後再編輯。',
    published_chapters_cannot_merge: '作品已有發布版本。為保留舊版章節引用，不能合併。',
    chapter_has_reader_references: '後一章已有閱讀紀錄、書籤或閱讀進度，暫時不能合併。',
    chapters_not_adjacent: '兩章不再相鄰，請重新載入章節清單。',
    unknown_content_reference: '正文包含目前章節沒有的圖片引用，請保留原有圖片標記。',
    content_reference_unavailable: '圖片引用資料目前無法讀取，內容未有變更。',
    merged_content_too_large: '合併後正文超過 3 MiB。',
    payload_too_large: '正文超出伺服器單次編輯限制。',
  };
  return messages[code] ?? '儲存失敗。草稿內容仍保留，請重新載入後再試。';
}

/**
 * Admin chapter editor for a single work. Mount from the draft workflow with
 * the selected workId; edits are saved as new immutable revisions.
 */
export function ChapterEditor({
  workId,
  refresh = 0,
  initialChapterId = '',
  initialParagraphIndex = 0,
  onChanged,
}: {
  workId: string;
  refresh?: number;
  initialChapterId?: string;
  initialParagraphIndex?: number;
  onChanged?(): void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [chapterId, setChapterId] = useState('');
  const [chapter, setChapter] = useState<ChapterDetail | null>(null);
  const [labelRaw, setLabelRaw] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [splitAfter, setSplitAfter] = useState(1);
  const [rightLabel, setRightLabel] = useState('');
  const [rightTitle, setRightTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const paragraphs = useMemo(() => body === '' ? [] : body.split('\n\n'), [body]);
  const selectedIndex = chapters.findIndex((item) => item.id === chapterId);
  const nextChapter = chapters[selectedIndex + 1];
  const dirty = !!chapter && (body !== chapter.body || title !== chapter.title || labelRaw !== chapter.labelRaw);

  useEffect(() => {
    setChapters([]); setChapterId(''); setChapter(null); setMessage(''); setSuccess(false);
  }, [workId]);

  useEffect(() => {
    let active = true;
    if (!workId) return;
    setLoading(true);
    api<{ chapters: ChapterRow[] }>(`/api/admin/chapter-editor/works/${workId}/chapters`)
      .then((data) => {
        if (!active) return;
        setChapters(data.chapters);
        setChapterId((current) => data.chapters.some((item) => item.id === current)
          ? current : data.chapters.find((item) => item.id === initialChapterId)?.id ?? data.chapters[0]?.id ?? '');
      })
      .catch((error) => { if (active) setMessage(errorText((error as { code?: string }).code ?? '')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workId, refresh, listVersion, initialChapterId]);

  useEffect(() => {
    let active = true;
    setChapter(null);
    if (!workId || !chapterId) return;
    setLoading(true);
    api<ChapterDetail>(`/api/admin/chapter-editor/works/${workId}/chapters/${chapterId}`)
      .then((data) => {
        if (!active) return;
        setChapter(data); setLabelRaw(data.labelRaw); setTitle(data.title); setBody(data.body);
        const count = data.body === '' ? 0 : data.body.split('\n\n').length;
        setSplitAfter(Math.max(1, Math.floor(count / 2)));
        setRightLabel(data.labelRaw ? `${data.labelRaw}（後半）` : '後半');
        setRightTitle(data.title ? `${data.title}（後半）` : '');
      })
      .catch((error) => { if (active) setMessage(errorText((error as { code?: string }).code ?? '')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workId, chapterId, listVersion]);

  useEffect(() => { if (initialChapterId) setChapterId(initialChapterId); }, [initialChapterId]);
  useEffect(() => {
    if (!chapter || chapter.chapterId !== initialChapterId || !Number.isSafeInteger(initialParagraphIndex) || initialParagraphIndex < 0) return;
    const canonical = chapter.body.split('\n\n');
    if (!canonical[initialParagraphIndex]) return;
    const start = canonical.slice(0, initialParagraphIndex).reduce((sum, text) => sum + text.length + 2, 0);
    bodyRef.current?.focus();
    bodyRef.current?.setSelectionRange(start, start + canonical[initialParagraphIndex].length);
  }, [chapter, initialChapterId, initialParagraphIndex]);

  const reload = (nextChapterId?: string) => {
    if (nextChapterId) setChapterId(nextChapterId);
    setListVersion((version) => version + 1);
    onChanged?.();
  };

  const save = async () => {
    if (!chapter || busy) return;
    setBusy(true); setMessage(''); setSuccess(false);
    try {
      const result = await api<{ revisionId: string; unchanged: boolean }>(
        `/api/admin/chapter-editor/works/${workId}/chapters/${chapterId}`,
        { method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ labelRaw, title, body, expectedRevisionId: chapter.revisionId }) },
      );
      setSuccess(true);
      setMessage(result.unchanged ? '內容沒有變更。' : '已儲存，新修訂已建立；舊修訂仍保留。');
      reload(chapterId);
    } catch (error) {
      setMessage(errorText((error as { code?: string }).code ?? ''));
    } finally { setBusy(false); }
  };

  const split = async () => {
    if (!chapter || busy || dirty) return;
    setBusy(true); setMessage(''); setSuccess(false);
    try {
      const result = await api<{ chapterId: string }>(
        `/api/admin/chapter-editor/works/${workId}/chapters/${chapterId}/split`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ afterParagraph: splitAfter, rightLabelRaw: rightLabel,
            rightTitle, expectedRevisionId: chapter.revisionId }) },
      );
      setSuccess(true); setMessage('已拆分章節，原修訂仍保留。');
      reload(result.chapterId);
    } catch (error) {
      setMessage(errorText((error as { code?: string }).code ?? ''));
    } finally { setBusy(false); }
  };

  const mergeNext = async () => {
    if (!chapter || !nextChapter?.revisionId || busy || dirty) return;
    const confirmed = window.confirm(`將「${nextChapter.labelRaw || nextChapter.title || '下一章'}」合併到本章。合併會保留兩章的正文修訂紀錄；已發布作品或已有讀者引用的章節不能合併。`);
    if (!confirmed) return;
    setBusy(true); setMessage(''); setSuccess(false);
    try {
      await api(`/api/admin/chapter-editor/works/${workId}/chapters/${chapterId}/merge-next`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nextChapterId: nextChapter.id, expectedRevisionId: chapter.revisionId,
          expectedNextRevisionId: nextChapter.revisionId, labelRaw, title }),
      });
      setSuccess(true); setMessage('已合併章節；被合併章節的歷史修訂已保留。');
      reload(chapterId);
    } catch (error) {
      setMessage(errorText((error as { code?: string }).code ?? ''));
    } finally { setBusy(false); }
  };

  return (
    <section className="admin-panel" data-testid="chapter-editor">
      <h2>章節編輯</h2>
      <p className="muted">直接修正文案、拆分或合併章節。每次儲存都建立新修訂，舊修訂會保留。</p>
      {!workId ? <p className="hint">請先選擇作品。</p> : <>
        <div className="field">
          <label htmlFor="chapter-editor-select">選擇章節</label>
          <select id="chapter-editor-select" className="input" value={chapterId} disabled={loading || busy}
            onChange={(event) => {
              if (dirty && !window.confirm('目前修改尚未儲存，確定切換章節？')) return;
              setMessage(''); setSuccess(false); setChapterId(event.target.value);
            }}>
            {chapters.map((item) => <option key={item.id} value={item.id}>
              {item.editorialPosition}. {item.labelRaw || '（未命名章節）'}{item.title ? `｜${item.title}` : ''}
            </option>)}
          </select>
        </div>
        {loading && <p className="hint" role="status">載入章節中…</p>}
        {!loading && chapters.length === 0 && <p className="hint">這部作品尚未有章節。</p>}
        {chapter && <>
          <p className="hint">目前修訂：{chapter.revisionId.slice(0, 8)} · 共保留 {chapter.history.length} 個版本</p>
          <div className="field">
            <label htmlFor="chapter-editor-label">章節標籤</label>
            <input id="chapter-editor-label" className="input" value={labelRaw}
              onChange={(event) => setLabelRaw(event.target.value)} maxLength={300} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="chapter-editor-title">章節標題</label>
            <input id="chapter-editor-title" className="input" value={title}
              onChange={(event) => setTitle(event.target.value)} maxLength={300} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="chapter-editor-body">正文</label>
            <textarea ref={bodyRef} id="chapter-editor-body" className="input" rows={18} value={body}
              onChange={(event) => setBody(event.target.value)} disabled={busy} />
            {initialChapterId === chapterId && <span className="hint">回報位置：第 {initialParagraphIndex + 1} 段。此處為目前草稿，請與回報摘錄核對後修正。</span>}
            <span className="hint">段落之間以空行分隔。保留原有圖片標記，單章上限 3 MiB。</span>
          </div>
          <div className="row-actions">
            <button className="btn primary" onClick={() => void save()} disabled={busy || loading} aria-busy={busy || undefined}>
              {busy ? '儲存中…' : '儲存修訂'}
            </button>
          </div>
          <details>
            <summary>拆分或合併章節</summary>
            <p className="hint">拆分只會在段落之間進行。合併會保留正文修訂紀錄；已有發布版本或讀者引用時會阻止合併，以免舊版內容或書籤失效。</p>
            {dirty && <p className="hint">請先儲存目前修改，再拆分或合併章節。</p>}
            {paragraphs.length > 1 && <div className="field">
              <label htmlFor="chapter-editor-split">拆分位置</label>
              <select id="chapter-editor-split" className="input" value={splitAfter}
                onChange={(event) => setSplitAfter(Number(event.target.value))} disabled={busy}>
                {paragraphs.slice(1).map((_, index) => <option key={index + 1} value={index + 1}>
                  第 {index + 1} 段之後
                </option>)}
              </select>
            </div>}
            {paragraphs.length > 1 && <>
              <div className="field">
                <label htmlFor="chapter-editor-right-label">新章節標籤</label>
                <input id="chapter-editor-right-label" className="input" value={rightLabel}
                  onChange={(event) => setRightLabel(event.target.value)} maxLength={300} disabled={busy} />
              </div>
              <div className="field">
                <label htmlFor="chapter-editor-right-title">新章節標題</label>
                <input id="chapter-editor-right-title" className="input" value={rightTitle}
                  onChange={(event) => setRightTitle(event.target.value)} maxLength={300} disabled={busy} />
              </div>
              <button className="btn" onClick={() => void split()} disabled={busy || dirty || !rightLabel.trim()}>
                拆分成兩章
              </button>
            </>}
            {nextChapter && <button className="btn" onClick={() => void mergeNext()} disabled={busy || dirty || !nextChapter.revisionId}>
              合併下一章到本章
            </button>}
          </details>
        </>}
      </>}
      {message && <p className={success ? 'form-ok' : 'form-error'} role={success ? 'status' : 'alert'}>{message}</p>}
    </section>
  );
}
