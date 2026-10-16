// Admin taxonomy panel (§50): categories/tags CRUD + per-work assignment.
// Minimal usable screens; alias/merge remain deferred backlog. Deactivation is
// deliberately the only removal — history stays intact.
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { SkeletonLines } from '../components/Skeleton.tsx';
import { TaxonomyPicker, type TaxonomySelection } from './TaxonomyPicker.tsx';
import { useTaxonomy } from './useTaxonomy.ts';

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function TaxonomyPanel() {
  const [kind, setKind] = useState<'categories' | 'tags'>('categories');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  // shared with the import and publish pickers, so an item created there is
  // already listed here (and vice versa) without a reload
  const taxonomy = useTaxonomy();
  const items = taxonomy[kind];
  const loading = !taxonomy.loaded && !taxonomy.error;

  const create = async () => {
    setMsg('');
    try {
      await taxonomy.create(kind, name.trim());
      setName('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '建立失敗');
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      await api(`/api/admin/taxonomy/${kind}/${id}`, json('PATCH', body));
      await taxonomy.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '更新失敗');
    }
  };

  const unit = kind === 'categories' ? '分類' : '標籤';

  return (
    <section className="admin-panel" data-testid="taxonomy-panel">
      <h2>分類與標籤</h2>
      <p className="muted">
        名稱與 ID 分開：改名不換 ID，收藏、URL 與匯入對應都不會斷。停用後禁止新指派，歷史關聯保留。
      </p>

      <div className="seg" role="tablist" aria-label="詞庫種類">
        {([['categories', '分類'], ['tags', '標籤']] as const).map(([v, label]) => (
          <button key={v} role="tab" aria-selected={kind === v} className="seg-item"
            onClick={() => setKind(v)}>{label}</button>
        ))}
      </div>

      <div className="form-row">
        <input className="input" placeholder={`新${unit}名稱`} value={name}
          onChange={(e) => setName(e.target.value)} aria-label="新名稱"
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void create(); }} />
        <button className="btn" onClick={create} disabled={!name.trim()}>新增</button>
      </div>
      {msg && <p className="form-error" role="alert">{msg}</p>}

      {loading && items.length === 0 && <SkeletonLines count={4} label="載入詞庫" />}

      {!loading && items.length === 0 && (
        <div className="empty">
          <h2>還沒有{unit}</h2>
          <p>先建立幾個{unit}，之後才能在作品上指派，讀者也才篩得到。</p>
        </div>
      )}

      {items.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr><th>名稱</th><th>排序</th><th>狀態</th><th>操作</th></tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>{it.displayName}</td>
                <td className="tnum">{it.sortOrder}</td>
                <td>
                  <span className={it.isActive ? 'state state-ok' : 'state'}>
                    {it.isActive ? '啟用' : '停用'}
                  </span>
                </td>
                <td className="row-actions">
                  <button className="chip" onClick={() => {
                    const next = window.prompt(`${unit}新名稱`, it.displayName);
                    if (next && next.trim()) void patch(it.id, { displayName: next.trim() });
                  }}>改名</button>
                  <button className="chip" onClick={() => void patch(it.id, { isActive: !it.isActive })}>
                    {it.isActive ? '停用' : '啟用'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <WorkAssignment />
    </section>
  );
}

type WorkOption = { id: string; title: string; author: string };

// Finding a work by name instead of by pasted UUID: the admin knows the title,
// not the id, and copying ids between tabs was the only way to use this before.
function WorkAssignment() {
  const [query, setQuery] = useState('');
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [workId, setWorkId] = useState('');
  const [selection, setSelection] = useState<TaxonomySelection | null>(null);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api<{ works: WorkOption[] }>(`/api/admin/works?q=${encodeURIComponent(query)}`)
        .then((r) => { if (active) setWorks(r.works); })
        .catch(() => { if (active) setMsg('無法載入作品清單，請重試。'); });
    }, query ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    let active = true;
    setSelection(null); setMsg(''); setOk(false);
    if (!workId) return;
    api<{ categoryIds: string[]; tagIds: string[] }>(`/api/admin/works/${workId}/taxonomy`)
      .then((r) => { if (active) setSelection({ categoryIds: r.categoryIds, tagIds: r.tagIds }); })
      .catch(() => { if (active) setMsg('載入這部作品的指派失敗，請重選或重試。'); });
    return () => { active = false; };
  }, [workId]);

  const save = async () => {
    if (!selection) return;
    setBusy(true); setMsg(''); setOk(false);
    try {
      await api(`/api/admin/works/${workId}/taxonomy`, json('PUT', selection));
      setOk(true);
      setMsg('已儲存作品的分類與標籤。');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '儲存失敗');
    } finally { setBusy(false); }
  };

  return (
    <section className="admin-sub">
      <h3>作品分類／標籤指派</h3>
      <p className="hint">匯入時已可直接指派；這裡用於事後調整既有作品。</p>
      <div className="field">
        <label htmlFor="assign-search">搜尋作品名稱或作者</label>
        <input className="input" id="assign-search" type="search" value={query}
          onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="assign-work">選擇作品</label>
        <select className="input" id="assign-work" value={workId} onChange={(e) => setWorkId(e.target.value)}>
          <option value="">請選擇作品</option>
          {works.map((w) => <option key={w.id} value={w.id}>{w.title}{w.author ? `／${w.author}` : ''}</option>)}
        </select>
        {!works.length && <span className="hint">{query ? '沒有符合搜尋的作品。' : '尚未有作品。'}</span>}
      </div>
      {msg && <p className={ok ? 'form-ok' : 'form-error'} role="status">{msg}</p>}
      {selection && (
        <>
          <TaxonomyPicker idPrefix="assign" value={selection} onChange={setSelection} disabled={busy} />
          <button className="btn primary btn-block" onClick={save} disabled={busy}>
            {busy ? '儲存中…' : '儲存指派'}
          </button>
        </>
      )}
    </section>
  );
}
