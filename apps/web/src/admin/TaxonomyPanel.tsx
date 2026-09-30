// Admin taxonomy panel (§50): categories/tags CRUD + per-work assignment.
// Minimal usable screens; alias/merge remain deferred backlog.
import { useCallback, useEffect, useState } from 'react';
import { api, getCategories, getTags } from '../api/client.ts';
import type { TaxonomyItem, TaxonomyListResponse } from '../api/types.ts';

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

  const refresh = useCallback(() => {
    const loader: (i: boolean) => Promise<TaxonomyListResponse> = kind === 'categories' ? getCategories : getTags;
    loader(true).then((r) => setItems(r.items)).catch(() => setItems([]));
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

  return (
    <section className="admin-panel" data-testid="taxonomy-panel">
      <h2>分類與標籤</h2>
      <div className="form-row">
        <div className="type-tabs" role="tablist">
          <button role="tab" aria-selected={kind === 'categories'} className={`chip${kind === 'categories' ? ' active' : ''}`} onClick={() => setKind('categories')}>分類</button>
          <button role="tab" aria-selected={kind === 'tags'} className={`chip${kind === 'tags' ? ' active' : ''}`} onClick={() => setKind('tags')}>標籤</button>
        </div>
      </div>
      <div className="form-row">
        <input placeholder={kind === 'categories' ? '新分類名稱' : '新標籤名稱'} value={name}
          onChange={(e) => setName(e.target.value)} aria-label="新名稱" />
        <button className="reader-btn" onClick={create} disabled={!name.trim()}>新增</button>
      </div>
      {msg && <p className="form-msg">{msg}</p>}
      <table className="admin-table">
        <thead>
          <tr><th>名稱</th><th>排序</th><th>狀態</th><th>操作</th></tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.displayName}</td>
              <td>{it.sortOrder}</td>
              <td>{it.isActive ? '啟用' : '停用'}</td>
              <td className="row-actions">
                <button className="reader-btn chip" onClick={() => {
                  const next = window.prompt('新名稱', it.displayName);
                  if (next && next.trim()) void patch(it.id, { displayName: next.trim() });
                }}>改名</button>
                <button className="reader-btn chip" onClick={() => void patch(it.id, { isActive: !it.isActive })}>
                  {it.isActive ? '停用' : '啟用'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

  useEffect(() => {
    Promise.all([getCategories(true), getTags(true)]).then(([c, t]) => { setAllCats(c.items); setAllTags(t.items); });
  }, []);

  const load = async () => {
    setMsg('');
    try {
      const r = await api<{ categories: TaxonomyItem[]; tags: TaxonomyItem[] }>(`/api/admin/works/${workId.trim()}/taxonomy`);
      setLoaded({ categories: r.categories, tags: r.tags });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '載入失敗');
    }
  };

  const save = async () => {
    if (!loaded) return;
    setMsg('');
    try {
      await api(`/api/admin/works/${workId.trim()}/taxonomy`, json('PUT', {
        categoryIds: loaded.categories.map((c) => c.id),
        tagIds: loaded.tags.map((t) => t.id),
      }));
      setMsg('已儲存作品分類／標籤。');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '儲存失敗');
    }
  };

  const toggle = (list: TaxonomyItem[], item: TaxonomyItem) =>
    list.some((x) => x.id === item.id) ? list.filter((x) => x.id !== item.id) : [...list, item];
  const chip = (selected: boolean) => `reader-btn chip${selected ? ' active selected' : ''}`;

  return (
    <section className="admin-panel">
      <h3>作品分類／標籤指派</h3>
      <div className="form-row">
        <input placeholder="作品 UUID" value={workId} onChange={(e) => setWorkId(e.target.value)} aria-label="作品 UUID" />
        <button className="reader-btn" onClick={load} disabled={!workId.trim()}>載入</button>
      </div>
      {msg && <p className="form-msg">{msg}</p>}
      {loaded && (
        <>
          <p><b>分類</b>（上限 5）</p>
          <div className="setting-control">
            {allCats.map((c) => (
              <button key={c.id} className={chip(loaded.categories.some((x) => x.id === c.id))}
                aria-pressed={loaded.categories.some((x) => x.id === c.id)}
                onClick={() => setLoaded({ ...loaded, categories: toggle(loaded.categories, c) })}>
                {loaded.categories.some((x) => x.id === c.id) ? '✓ ' : ''}{c.displayName}{c.isActive ? '' : '（停用）'}
              </button>
            ))}
          </div>
          <p><b>標籤</b>（上限 20）</p>
          <div className="setting-control">
            {allTags.map((t) => (
              <button key={t.id} className={chip(loaded.tags.some((x) => x.id === t.id))}
                aria-pressed={loaded.tags.some((x) => x.id === t.id)}
                onClick={() => setLoaded({ ...loaded, tags: toggle(loaded.tags, t) })}>
                {loaded.tags.some((x) => x.id === t.id) ? '✓ ' : ''}{t.displayName}{t.isActive ? '' : '（停用）'}
              </button>
            ))}
          </div>
          <p><button className="reader-btn primary" onClick={save}>儲存指派</button></p>
        </>
      )}
    </section>
  );
}
