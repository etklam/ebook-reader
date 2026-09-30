// Public catalog (§21): mobile-first library home. Filter state lives in the
// URL (§22) so views are shareable and back/forward restore them.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCatalog, getPublicTaxonomy } from '../api/client.ts';
import type { CatalogWork, TaxonomyItem } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { WorkCard } from './WorkCard.tsx';
import { BottomSheet } from '../reader/BottomSheet.tsx';
import { debounce } from '../reader/pagination.ts';

export interface CatalogFilterState {
  q: string;
  type: '' | 'short_story' | 'serial';
  categoryIds: string[];
  tagIds: string[];
  tagMode: 'all' | 'any';
  serialStatus: string[];
  sort: 'updated' | 'title';
}

export function filterFromSearch(search: string): CatalogFilterState {
  const p = new URLSearchParams(search);
  return {
    q: p.get('q') ?? '',
    type: (p.get('type') as CatalogFilterState['type']) ?? '',
    categoryIds: (p.get('categoryIds') ?? '').split(',').filter(Boolean),
    tagIds: (p.get('tagIds') ?? '').split(',').filter(Boolean),
    tagMode: p.get('tagMode') === 'any' ? 'any' : 'all',
    serialStatus: (p.get('serialStatus') ?? '').split(',').filter(Boolean),
    sort: p.get('sort') === 'title' ? 'title' : 'updated',
  };
}

export function filterToSearch(f: CatalogFilterState): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.type) p.set('type', f.type);
  if (f.categoryIds.length) p.set('categoryIds', f.categoryIds.join(','));
  if (f.tagIds.length) p.set('tagIds', f.tagIds.join(','));
  if (f.tagIds.length && f.tagMode === 'any') p.set('tagMode', 'any');
  if (f.serialStatus.length) p.set('serialStatus', f.serialStatus.join(','));
  if (f.sort !== 'updated') p.set('sort', f.sort);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const PAGE = 20;

export function CatalogPage() {
  const [filter, setFilter] = useState(() => filterFromSearch(location.search));
  const [works, setWorks] = useState<CatalogWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [categories, setCategories] = useState<TaxonomyItem[]>([]);
  const [tags, setTags] = useState<TaxonomyItem[]>([]);
  const [searchText, setSearchText] = useState(filter.q);
  const debouncedApply = useRef(debounce((q: string) => applyFilter({ ...filterRef.current, q }), 400)).current;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // URL → state on back/forward
  useEffect(() => {
    const onPop = () => setFilter(filterFromSearch(location.search));
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  // state → URL (replaceState; shareable and restorable)
  const applyFilter = useCallback((next: CatalogFilterState) => {
    setFilter(next);
    const search = filterToSearch(next);
    history.replaceState(null, '', location.pathname + search);
  }, []);

  const load = useCallback((f: CatalogFilterState, offset: number, append: boolean) => {
    setLoading(true);
    getCatalog({
      q: f.q || undefined, type: f.type || undefined,
      categoryIds: f.categoryIds, tagIds: f.tagIds, tagMode: f.tagMode,
      serialStatus: f.serialStatus, sort: f.sort, limit: PAGE, offset,
    }).then((r) => {
      setWorks((prev) => (append ? [...prev, ...r.works] : r.works));
      setDone(r.works.length < PAGE);
    }).catch(() => setWorks([])).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(filter, 0, false); }, [filter, load]);

  const openDetail = (id: string) => navigate(`/works/${id}${location.search}`);

  const activeFilterCount =
    (filter.categoryIds.length ? 1 : 0) + (filter.tagIds.length ? 1 : 0) +
    (filter.serialStatus.length ? 1 : 0) + (filter.type ? 1 : 0);

  return (
    <div className="catalog" data-testid="catalog">
      <header className="catalog-head">
        <h1>書庫</h1>
        <div className="type-tabs" role="tablist" aria-label="作品類型">
          {[
            { v: '', label: '全部' },
            { v: 'serial', label: '長篇連載' },
            { v: 'short_story', label: '短篇' },
          ].map((t) => (
            <button
              key={t.v}
              role="tab"
              aria-selected={filter.type === t.v}
              className={`chip${filter.type === t.v ? ' active' : ''}`}
              onClick={() => applyFilter({ ...filter, type: t.v as CatalogFilterState['type'] })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="search-row">
          <input
            type="search"
            placeholder="搜尋書名、作者、分類、標籤（支援繁簡）"
            aria-label="搜尋"
            value={searchText}
            onChange={(e) => { setSearchText(e.target.value); debouncedApply(e.target.value); }}
          />
          <button className="reader-btn" aria-label="篩選" onClick={() => setSheetOpen(true)}>
            篩選{activeFilterCount > 0 ? `(${activeFilterCount})` : ''}
          </button>
        </div>
      </header>

      {loading && works.length === 0 && <p className="muted">載入中…</p>}
      {!loading && works.length === 0 && <p className="muted" data-testid="catalog-empty">沒有符合條件的作品。</p>}
      <div className="work-list">
        {works.map((w) => <WorkCard key={w.id} work={w} onOpen={() => openDetail(w.id)} />)}
      </div>
      {!done && works.length > 0 && (
        <button className="reader-btn load-more" disabled={loading} onClick={() => load(filter, works.length, true)}>
          載入更多
        </button>
      )}

      <BottomSheet open={sheetOpen} title="篩選" onClose={() => setSheetOpen(false)}>
        <FilterSheet
          filter={filter}
          categories={categories}
          tags={tags}
          onOpen={() => Promise.all([getPublicTaxonomy('categories'), getPublicTaxonomy('tags')]).then(([c, t]) => { setCategories(c.items as TaxonomyItem[]); setTags(t.items as TaxonomyItem[]); })}
          onChange={applyFilter}
          onClear={() => applyFilter({ ...filter, categoryIds: [], tagIds: [], tagMode: 'all', serialStatus: [] })}
          onApply={() => { setSheetOpen(false); }}
        />
      </BottomSheet>
    </div>
  );
}

function FilterSheet({ filter, categories, tags, onOpen, onChange, onClear, onApply }: {
  filter: CatalogFilterState;
  categories: TaxonomyItem[];
  tags: TaxonomyItem[];
  onOpen(): void;
  onChange(f: CatalogFilterState): void;
  onClear(): void;
  onApply(): void;
}) {
  useEffect(() => { void onOpen(); }, [onOpen]);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  // selections are marked with ✓ + border, not color alone (§21)
  const chip = (selected: boolean) => `reader-btn chip${selected ? ' active selected' : ''}`;

  return (
    <div data-testid="filter-sheet">
      <div className="setting-row">
        <span className="setting-label">排序</span>
        <div className="setting-control">
          <button className={chip(filter.sort === 'updated')} aria-pressed={filter.sort === 'updated'}
            onClick={() => onChange({ ...filter, sort: 'updated' })}>最近更新</button>
          <button className={chip(filter.sort === 'title')} aria-pressed={filter.sort === 'title'}
            onClick={() => onChange({ ...filter, sort: 'title' })}>書名</button>
        </div>
      </div>
      <div className="setting-row">
        <span className="setting-label">分類</span>
        <div className="setting-control">
          {categories.map((c) => (
            <button key={c.id} className={chip(filter.categoryIds.includes(c.id))}
              aria-pressed={filter.categoryIds.includes(c.id)}
              onClick={() => onChange({ ...filter, categoryIds: toggle(filter.categoryIds, c.id) })}>
              {filter.categoryIds.includes(c.id) ? '✓ ' : ''}{c.displayName}
            </button>
          ))}
          {categories.length === 0 && <span className="muted">載入中…</span>}
        </div>
      </div>
      <div className="setting-row">
        <span className="setting-label">標籤</span>
        <div className="setting-control">
          {tags.map((t) => (
            <button key={t.id} className={chip(filter.tagIds.includes(t.id))}
              aria-pressed={filter.tagIds.includes(t.id)}
              onClick={() => onChange({ ...filter, tagIds: toggle(filter.tagIds, t.id) })}>
              {filter.tagIds.includes(t.id) ? '✓ ' : ''}{t.displayName}
            </button>
          ))}
        </div>
      </div>
      {filter.tagIds.length > 1 && (
        <div className="setting-row">
          <span className="setting-label">標籤模式</span>
          <div className="setting-control">
            <button className={chip(filter.tagMode === 'all')} aria-pressed={filter.tagMode === 'all'}
              onClick={() => onChange({ ...filter, tagMode: 'all' })}>全部符合</button>
            <button className={chip(filter.tagMode === 'any')} aria-pressed={filter.tagMode === 'any'}
              onClick={() => onChange({ ...filter, tagMode: 'any' })}>任一符合</button>
          </div>
        </div>
      )}
      <div className="setting-row">
        <span className="setting-label">連載狀態</span>
        <div className="setting-control">
          {[
            { v: 'ongoing', label: '連載中' },
            { v: 'completed', label: '已完結' },
            { v: 'paused', label: '暫停' },
          ].map((s) => (
            <button key={s.v} className={chip(filter.serialStatus.includes(s.v))}
              aria-pressed={filter.serialStatus.includes(s.v)}
              onClick={() => onChange({ ...filter, serialStatus: toggle(filter.serialStatus, s.v) })}>
              {filter.serialStatus.includes(s.v) ? '✓ ' : ''}{s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="sheet-actions">
        <button className="reader-btn" onClick={onClear}>清除篩選</button>
        <button className="reader-btn primary" onClick={onApply}>套用</button>
      </div>
    </div>
  );
}
