// Admin taxonomy panel (§50): categories/tags CRUD + per-work assignment.
// Minimal usable screens; alias/merge remain deferred backlog. Deactivation is
// deliberately the only removal — history stays intact.
import { useCallback, useEffect, useState } from 'react';
import { api, getCategories, getTags } from '../api/client.ts';
import type { TaxonomyItem, TaxonomyListResponse } from '../api/types.ts';
import { SkeletonLines } from '../components/Skeleton.tsx';

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function TaxonomyPanel() {
  const [kind, setKind] = useState<'categories' | 'tags'>('categories');
  const [items, setItems] = useState<TaxonomyItem[]>([]);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    const loader: (i: boolean) => Promise<TaxonomyListResponse> = kind === 'categories' ? getCategories : getTags;
    setLoading(true);
    loader(true).then((r) => setItems(r.items)).catch(() => setItems([])).finally(() => setLoading(false));
  }, [kind]);
  useEffect(() => { refresh(); }, [refresh]);

  const create = async () => {
    setMsg('');
    try {
      await api(`/api/admin/taxonomy/${kind}`, json('POST', { displayName: name.trim() }));
      setName('');
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '建立失敗');
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      await api(`/api/admin/taxonomy/${kind}/${id}`, json('PATCH', body));
      refresh();
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

function WorkAssignment() {
  const [workId, setWorkId] = useState('');
  const [loaded, setLoaded] = useState<{ categories: TaxonomyItem[]; tags: TaxonomyItem[] } | null>(null);
  const [allCats, setAllCats] = useState<TaxonomyItem[]>([]);
  const [allTags, setAllTags] = useState<TaxonomyItem[]>([]);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);

  useEffect(() => {
    Promise.all([getCategories(true), getTags(true)]).then(([c, t]) => { setAllCats(c.items); setAllTags(t.items); });
  }, []);

  const load = async () => {
    setMsg(''); setOk(false);
    try {
      const r = await api<{ categories: TaxonomyItem[]; tags: TaxonomyItem[] }>(`/api/admin/works/${workId.trim()}/taxonomy`);
      setLoaded({ categories: r.categories, tags: r.tags });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '載入失敗');
    }
  };

  const save = async () => {
    if (!loaded) return;
    setMsg(''); setOk(false);
    try {
      await api(`/api/admin/works/${workId.trim()}/taxonomy`, json('PUT', {
        categoryIds: loaded.categories.map((c) => c.id),
        tagIds: loaded.tags.map((t) => t.id),
      }));
      setOk(true);
      setMsg('已儲存作品的分類與標籤。');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '儲存失敗');
    }
  };

  const toggle = (list: TaxonomyItem[], item: TaxonomyItem) =>
    list.some((x) => x.id === item.id) ? list.filter((x) => x.id !== item.id) : [...list, item];

  const picker = (
    all: TaxonomyItem[],
    chosen: TaxonomyItem[],
    onToggle: (i: TaxonomyItem) => void,
    label: string,
  ) => (
    <div className="setting-control" role="group" aria-label={label}>
      {all.map((it) => {
        const on = chosen.some((x) => x.id === it.id);
        return (
          <button key={it.id} className={`chip${on ? ' selected' : ''}`} aria-pressed={on}
            onClick={() => onToggle(it)}>
            {on ? '✓ ' : ''}{it.displayName}{it.isActive ? '' : '（停用）'}
          </button>
        );
      })}
      {all.length === 0 && <span className="muted">尚無可指派的項目</span>}
    </div>
  );

  return (
    <section className="admin-sub">
      <h3>作品分類／標籤指派</h3>
      <div className="form-row">
        <input className="input input-mono" placeholder="作品 UUID" value={workId}
          aria-label="作品 UUID" onChange={(e) => setWorkId(e.target.value)} />
        <button className="btn" onClick={load} disabled={!workId.trim()}>載入</button>
      </div>
      {msg && <p className={ok ? 'form-ok' : 'form-error'} role="status">{msg}</p>}
      {loaded && (
        <>
          <h3>分類<span className="hint">　最多 5 個</span></h3>
          {picker(allCats, loaded.categories,
            (c) => setLoaded({ ...loaded, categories: toggle(loaded.categories, c) }), '分類')}
          <h3>標籤<span className="hint">　最多 20 個</span></h3>
          {picker(allTags, loaded.tags,
            (t) => setLoaded({ ...loaded, tags: toggle(loaded.tags, t) }), '標籤')}
          <button className="btn primary btn-block" onClick={save}>儲存指派</button>
        </>
      )}
    </section>
  );
}
