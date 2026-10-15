import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '../api/client.ts';
import { applyIdentity, needsDecision, reviewReason, reviewText, type ReviewRow } from './import-review-state.ts';

type Review = { editVersion: number; analysisVersion: string; page: number; limit: number; total: number; counts: Record<string, number>; pendingCount: number; rows: ReviewRow[] };
type Body = { text: string; title: string; hasMore: boolean; total: number; resources: Array<{ content_hash: string; alt: string }> };
type Summary = { added: number; updated: number; unchanged: number; modifiedKept: number; skipped: number; missingKept: number };
type Detail = { source: Body; site: Body; offset: number };
const labels: Record<string, string> = { all: '全部', unchanged: '相同', modified: '有修訂', new: '新章', pending: '待決', ambiguous: '歧義', structural_conflict: '結構衝突', missing: '來源缺失' };
const failure = (error: unknown) => error instanceof ApiRequestError
  ? error.code === 'duplicate_resolution_target' ? '同一站方章節不能對應多個來源項目，請修正對應、排除重複項目或修正來源後重新分析。' : ['analysis_version_conflict', 'edit_version_conflict'].includes(error.code) ? '作品或分析版本已改變，請按「重新比對」並重新檢視決策。' : `讀取或套用失敗（${error.code}），可重試。`
  : '網絡連線失敗，請重試；同一方案的套用重試會沿用提交識別。';

export function ImportReview({ importId, applied, onApplied, onBaseline }: { importId: string; applied: boolean; onApplied(result: unknown): void; onBaseline(version: number): void }) {
  const [review, setReview] = useState<Review | null>(null);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [decisionLabels, setDecisionLabels] = useState<Record<string, string>>({});
  const [mode, setMode] = useState('incremental');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [plan, setPlan] = useState<{ payload: string; summary: Summary } | null>(null);
  const operation = useRef<{ payload: string; key: string } | null>(null);
  const baseline = useRef('');
  const baselineCallback = useRef(onBaseline); baselineCallback.current = onBaseline;
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false); setError('');
    api<Review>(`/api/admin/imports/${importId}/review?page=${page}&filter=${filter}`, { signal: controller.signal }).then((next) => {
      const version = `${next.editVersion}:${next.analysisVersion}`;
      if (baseline.current && baseline.current !== version) { setResolutions({}); setDecisionLabels({}); setAcknowledged(false); operation.current = null; }
      baseline.current = version; setReview(next); setLoaded(true); setStale(false); baselineCallback.current(next.editVersion);
    }).catch((error) => { if (!controller.signal.aborted) setError(failure(error)); });
    return () => controller.abort();
  }, [importId, page, filter, reload]);
  const unresolved = Math.max(0, (review?.pendingCount ?? 0) - Object.keys(resolutions).length);
  const changeDecision = (id: string, decision: string, label: string) => {
    setResolutions((previous) => { const next = { ...previous }; if (decision) next[id] = decision; else delete next[id]; return next; });
    setDecisionLabels((previous) => ({ ...previous, [id]: label })); setAcknowledged(false);
  };
  const payload = review ? JSON.stringify({ baseEditVersion: review.editVersion, analysisVersion: review.analysisVersion, mode,
    resolutions: Object.fromEntries(Object.entries(resolutions).sort(([a], [b]) => a.localeCompare(b))) }) : '';
  async function preview() {
    setBusy(true); setError(''); setAcknowledged(false);
    try {
      const result = await api<{ summary: Summary }>(`/api/admin/imports/${importId}/review-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      setPlan({ payload, summary: result.summary });
    } catch (error) {
      setError(failure(error));
      if (error instanceof ApiRequestError && ['analysis_version_conflict', 'edit_version_conflict'].includes(error.code)) setStale(true);
    } finally { setBusy(false); }
  }
  async function apply() {
    if (!review || unresolved || stale || !loaded || !acknowledged || plan?.payload !== payload) return;
    setBusy(true); setError('');
    operation.current = applyIdentity(operation.current, payload, () => crypto.randomUUID());
    try {
      const result = await api(`/api/admin/imports/${importId}/apply`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': operation.current.key }, body: payload });
      onApplied(result);
    } catch (error) {
      setError(failure(error));
      if (error instanceof ApiRequestError && ['analysis_version_conflict', 'edit_version_conflict'].includes(error.code)) setStale(true);
      if (error instanceof ApiRequestError && error.code === 'resolution_required') { setFilter('pending'); setPage(1); }
    } finally { setBusy(false); }
  }
  return <section className="import-review" aria-label="逐章匯入比對" aria-busy={!loaded || busy}>
    <div className="row-actions"><button className="btn" disabled={busy} onClick={() => { setResolutions({}); setDecisionLabels({}); setAcknowledged(false); operation.current = null; setReload((value) => value + 1); }}>重新比對</button>
      <label>顯示 <select className="input" value={filter} disabled={busy} onChange={(event) => { setFilter(event.target.value); setPage(1); }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {!loaded && !error && <p className="hint" role="status">正在比對章節…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {review && <>
      <p className="hint">編輯版本 {review.editVersion}：相同 {review.counts.unchanged}、有修訂 {review.counts.modified}、新章 {review.counts.new}、歧義 {review.counts.ambiguous}、結構衝突 {review.counts.structural_conflict}、來源缺失 {review.counts.missing}。</p>
      <p className="hint">來源缺失的站方章節會保留。套用後仍須另外發布，公開內容才會改變。</p>
      <div className="import-review-list">{review.rows.map((row) => <ReviewItem key={row.itemId ?? row.chapterId} importId={importId} row={row} review={review} decision={resolutions[row.itemId ?? ''] ?? ''} disabled={busy || stale || applied} onDecision={changeDecision} onStale={() => setStale(true)} />)}</div>
      {!review.rows.length && <p className="hint">這個分類沒有章節，可選擇其他分類繼續檢視。</p>}
      <div className="row-actions"><button className="btn" disabled={page === 1 || !loaded || busy} onClick={() => setPage(page - 1)}>上一頁</button><span>第 {page} 頁，共 {review.total} 項</span><button className="btn" disabled={page * review.limit >= review.total || !loaded || busy} onClick={() => setPage(page + 1)}>下一頁</button></div>
      {!applied && <>
        <h4>核對套用方案</h4>
        <label>套用方式 <select className="input" value={mode} disabled={busy} onChange={(event) => { setMode(event.target.value); setAcknowledged(false); }}><option value="incremental">增量：保留站方修訂</option><option value="overwrite">覆蓋：為差異建立新修訂</option></select></label>
        <p>{mode === 'incremental' ? `相同章節不變；${review.counts.modified} 個自動匹配修訂保留站方版本。` : `相同章節不變；${review.counts.modified} 個自動匹配修訂將採用來源建立新修訂。`}有錨點新章依下方位置插入；人工對應同樣遵循所選方式。</p>
        <p>人工決策 {Object.keys(resolutions).length} 項；尚有 {unresolved} 項待決。</p>
        {Object.entries(resolutions).length > 0 && <ul>{Object.entries(resolutions).map(([id, decision]) => <li key={id}>{decisionLabels[id]}：{decision === 'exclude' ? '排除，不匯入' : decision === 'new' ? '作為新章（依列示位置）' : '人工對應，依套用方式保留或更新'}</li>)}</ul>}
        {unresolved > 0 && <button className="btn" onClick={() => { setFilter('pending'); setPage(1); }}>檢視待決項目（{unresolved}）</button>}
        <button className="btn" disabled={busy || stale || unresolved > 0 || !loaded} onClick={() => void preview()}>核對實際套用數量</button>
        {plan?.payload === payload && <p role="status">實際方案：新增 {plan.summary.added}、更新 {plan.summary.updated}、相同 {plan.summary.unchanged}、保留站方修訂 {plan.summary.modifiedKept}、排除 {plan.summary.skipped}、保留來源缺失 {plan.summary.missingKept}。</p>}
        <label className="check-line"><input type="checkbox" checked={acknowledged && plan?.payload === payload} disabled={busy || stale || unresolved > 0 || plan?.payload !== payload} onChange={(event) => setAcknowledged(event.target.checked)} />我已核對逐章變更、插入位置與排除清單</label>
        <button className="btn primary" disabled={busy || !loaded || stale || unresolved > 0 || !acknowledged || plan?.payload !== payload} onClick={() => void apply()}>{busy ? '正在套用…' : mode === 'overwrite' ? '套用覆蓋方案' : '套用增量方案'}</button>
      </>}
    </>}
  </section>;
}

function ReviewItem({ importId, row, review, decision, disabled, onDecision, onStale }: { importId: string; row: ReviewRow; review: Review; decision: string; disabled: boolean; onDecision(id: string, value: string, label: string): void; onStale(): void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [target, setTarget] = useState(row.matchedChapterId ?? row.chapterId ?? '');
  const [query, setQuery] = useState('');
  const [targets, setTargets] = useState<Array<{ id: string; labelRaw: string; position: number }>>([]);
  const [moreTargets, setMoreTargets] = useState(false);
  const [searchedTargets, setSearchedTargets] = useState(false);
  const [retry, setRetry] = useState(0);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setError(''); setDetail(null);
    const params = new URLSearchParams({ analysisVersion: review.analysisVersion, editVersion: String(review.editVersion), offset: String(offset) });
    if (row.itemId) params.set('itemId', row.itemId);
    if (target) params.set('chapterId', target);
    api<Detail>(`/api/admin/imports/${importId}/review/detail?${params}`, { signal: controller.signal }).then(setDetail).catch((error) => {
      if (controller.signal.aborted) return; setError(failure(error));
      if (error instanceof ApiRequestError && error.status === 409) onStale();
    });
    return () => controller.abort();
  }, [open, target, offset, importId, row.itemId, review.analysisVersion, review.editVersion, retry]);
  async function searchTargets() {
    setSearching(true); setError('');
    try { const result = await api<{ chapters: typeof targets; hasMore: boolean }>(`/api/admin/imports/${importId}/review/targets?q=${encodeURIComponent(query)}`); setTargets(result.chapters); setMoreTargets(result.hasMore); setSearchedTargets(true); }
    catch (error) { setError(failure(error)); } finally { setSearching(false); }
  }
  return <article className="import-review-item">
    <button className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{row.labelRaw || '無章號'} · {labels[row.itemClass]}{needsDecision(row) ? decision ? '（已決策）' : '（待決）' : ''} · {open ? '收起' : '展開核對'}</button>
    {open && <>
      {row.reason && <p className="hint">比對依據：{row.reason.map(reviewReason).join('、')}</p>}
      {row.kind === 'missing' ? <p>來源未包含這一章；套用會保留站方內容。</p> : row.matchedChapterId ? <p>對應站方章節：{row.matchedLabel || row.matchedChapterId}。</p> : <p>插入位置：{row.insertAfterChapterId ? `在「${row.afterLabel || row.insertAfterChapterId}」之後` : row.insertBeforeChapterId ? `在「${row.beforeLabel || row.insertBeforeChapterId}」之前` : '沒有可用錨點；選擇作為新章會明確追加到作品結尾'}{row.insertBeforeChapterId && row.insertAfterChapterId ? `、「${row.beforeLabel || row.insertBeforeChapterId}」之前` : ''}。</p>}

      {needsDecision(row) && <>
        <p className="form-warn">不支援自動拆章、合章或重編號；若下列決策無法表達意圖，請修正來源後重新分析。</p>
        <label>決策 <select className="input" value={decision.startsWith('match:') ? 'match' : decision} disabled={disabled} onChange={(event) => { if (event.target.value !== 'match') onDecision(row.itemId!, event.target.value, row.labelRaw); else if (target) onDecision(row.itemId!, `match:${target}`, `${row.labelRaw} → ${target}`); }}>
          <option value="">尚未決策</option><option value="exclude">排除此來源章節</option><option value="new">作為新章：{row.insertAfterChapterId || row.insertBeforeChapterId ? '依錨點插入' : '明確追加到結尾'}</option><option value="match" disabled={!target}>對應下方選定的站方章節</option>
        </select></label>
        <div className="field"><label htmlFor={`target-${row.itemId}`}>尋找要對應的站方章節（保留原章號）</label><input id={`target-${row.itemId}`} className="input" value={query} onChange={(event) => setQuery(event.target.value)} disabled={disabled} /><button className="btn" disabled={disabled || searching} onClick={() => void searchTargets()}>{searching ? '搜尋中…' : '搜尋站方章節'}</button></div>
        {targets.length > 0 && <label>站方章節 <select className="input" value={target} disabled={disabled} onChange={(event) => { setTarget(event.target.value); setOffset(0); if (!event.target.value) { onDecision(row.itemId!, '', row.labelRaw); return; } onDecision(row.itemId!, `match:${event.target.value}`, `${row.labelRaw} → ${targets.find((item) => item.id === event.target.value)?.labelRaw}`); }}><option value="">選擇後核對正文</option>{targets.map((item) => <option key={item.id} value={item.id}>編輯順序 {item.position} · {item.labelRaw || '無章號'}</option>)}</select></label>}
        {searchedTargets && targets.length === 0 && <p className="hint">找不到相符的站方章號，請調整搜尋文字。</p>}
        {moreTargets && <p className="hint">僅顯示前 40 項，請縮小章號搜尋範圍。</p>}
      </>}
      {error && <div><p className="form-error" role="alert">{error}</p><button className="btn" onClick={() => setRetry((value) => value + 1)}>重新載入本章文字</button></div>}
      {!detail && !error && <p role="status">正在載入本章文字…</p>}
      {detail && <>
        <div className="import-review-comparison">{(['site', 'source'] as const).map((side) => <section key={side}><h4>{side === 'site' ? '站方' : '來源'}：{detail[side].title || '無章名'}</h4><pre className="import-review-body">{reviewText(detail[side].text) || '此側沒有正文'}</pre><p className="hint">資源：{detail[side].resources.length ? detail[side].resources.slice(0, 200).map((resource) => `${resource.content_hash.slice(0, 12)}${resource.alt ? `（${resource.alt}）` : ''}`).join('、') : '無'}{detail[side].resources.length > 200 ? '（超過 200 項，僅列前 200 項）' : ''}</p></section>)}</div>
        <div className="row-actions"><button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 24000))}>上一段正文</button><span>文字範圍 {offset + 1}–{offset + Math.max(detail.site.text.length, detail.source.text.length)}</span><button className="btn" disabled={!detail.site.hasMore && !detail.source.hasMore} onClick={() => setOffset(offset + 24000)}>接續正文</button></div>
      </>}
    </>}
  </article>;
}
