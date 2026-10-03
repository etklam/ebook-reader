// Public catalog (§21): mobile-first library home, set as an index of ruled
// rows. Applied filter state lives in the URL (§22) so views are shareable and
// back/forward restore them; the sheet edits a *draft* and only 套用 promotes it
// (§03A C). Totals are never invented — the public API deliberately returns
// total: null, so the header reports what is loaded.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCatalog, getPublicTaxonomy } from '../api/client.ts';
import type { CatalogWork, TaxonomyItem } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { WorkCard } from './WorkCard.tsx';
import { BottomSheet } from '../reader/BottomSheet.tsx';
import { debounce } from '../reader/pagination.ts';
import { Icon } from '../components/Icon.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';

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

const TYPE_TABS = [
  { v: '', label: '全部' },
  { v: 'serial', label: '長篇連載' },
  { v: 'short_story', label: '短篇' },
] as const;

const SERIAL_STATUS = [
  { v: 'ongoing', label: '連載中' },
  { v: 'completed', label: '已完結' },
  { v: 'paused', label: '暫停' },
] as const;

export function CatalogPage() {
  const [filter, setFilter] = useState(() => filterFromSearch(location.search));
  const [works, setWorks] = useState<CatalogWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [categories, setCategories] = useState<TaxonomyItem[]>([]);
  const [tags, setTags] = useState<TaxonomyItem[]>([]);
  const [searchText, setSearchText] = useState(filter.q);
  const debouncedApply = useRef(debounce((q: string) => applyFilter({ ...filterRef.current, q }), 400)).current;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const seqRef = useRef(0);

  // URL → state on back/forward
  useEffect(() => {
    const onPop = () => {
      const next = filterFromSearch(location.search);
      setFilter(next);
      setSearchText(next.q);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  // the vocabulary is needed up front, not just inside the sheet: the applied
  // summary has to name the categories and tags restored from the URL
  useEffect(() => {
    void Promise.all([getPublicTaxonomy('categories'), getPublicTaxonomy('tags')])
      .then(([c, t]) => { setCategories(c.items as TaxonomyItem[]); setTags(t.items as TaxonomyItem[]); })
      .catch(() => undefined);
  }, []);

  // state → URL (replaceState; shareable and restorable)
  const applyFilter = useCallback((next: CatalogFilterState) => {
    setFilter(next);
    const search = filterToSearch(next);
    history.replaceState(null, '', location.pathname + search);
  }, []);

  // Keyset pagination: "load more" continues from the server's opaque cursor,
  // not from works.length. With an offset a publication landing between two
  // pages shifted the window and silently skipped a book (CAT-03).
  const load = useCallback((f: CatalogFilterState, cursor: string | null, append: boolean) => {
    const seq = ++seqRef.current;
    setLoading(true);
    if (!append) setFailed(false);
    getCatalog({
      q: f.q || undefined, type: f.type || undefined,
      categoryIds: f.categoryIds, tagIds: f.tagIds, tagMode: f.tagMode,
      serialStatus: f.serialStatus, sort: f.sort, limit: PAGE,
      cursor: cursor ?? undefined,
    }).then((r) => {
      if (seq !== seqRef.current) return;   // a newer condition already won
      setWorks((prev) => (append ? [...prev, ...r.works] : r.works));
      setNextCursor(r.nextCursor);
      setDone(r.nextCursor === null);
    }).catch(() => {
      if (seq !== seqRef.current) return;
      if (!append) setWorks([]);
      setFailed(true);
    }).finally(() => {
      if (seq === seqRef.current) setLoading(false);
    });
  }, []);

  // a changed condition set always restarts from no cursor (§03A-C)
  useEffect(() => { setNextCursor(null); load(filter, null, false); }, [filter, load]);

  const openDetail = (id: string) => navigate(`/works/${id}${location.search}`);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.id, c.displayName);
    for (const t of tags) m.set(t.id, t.displayName);
    return (id: string) => m.get(id) ?? '（已停用條件）';
  }, [categories, tags]);

  const activeFilterCount =
    filter.categoryIds.length + filter.tagIds.length + filter.serialStatus.length;

  // applied conditions as individually removable chips (§03A C)
  const appliedChips: Array<{ key: string; label: string; remove: () => void }> = [
    ...filter.categoryIds.map((id) => ({
      key: `c:${id}`,
      label: nameOf(id),
      remove: () => applyFilter({ ...filter, categoryIds: filter.categoryIds.filter((x) => x !== id) }),
    })),
    ...filter.tagIds.map((id) => ({
      key: `t:${id}`,
      label: `#${nameOf(id)}`,
      remove: () => applyFilter({ ...filter, tagIds: filter.tagIds.filter((x) => x !== id) }),
    })),
    ...filter.serialStatus.map((v) => ({
      key: `s:${v}`,
      label: SERIAL_STATUS.find((s) => s.v === v)?.label ?? v,
      remove: () => applyFilter({ ...filter, serialStatus: filter.serialStatus.filter((x) => x !== v) }),
    })),
  ];

  const firstLoad = loading && works.length === 0;

  return (
    <div className="catalog" data-testid="catalog">
      <header className="page-head">
        <div className="head-line">
          <h1>書庫</h1>
          <span className="head-note">
            {firstLoad ? '載入中' : `已載入 ${works.length} 部${done ? '' : '，可載入更多'}`}
          </span>
        </div>
        <div className="seg" role="tablist" aria-label="作品類型">
          {TYPE_TABS.map((t) => (
            <button
              key={t.v}
              role="tab"
              aria-selected={filter.type === t.v}
              className="seg-item"
              onClick={() => applyFilter({ ...filter, type: t.v as CatalogFilterState['type'] })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="catalog-tools">
          <div className="search-row">
            <input
              className="input"
              type="search"
              placeholder="搜尋書名、作者、分類、標籤"
              aria-label="搜尋"
              value={searchText}
              onChange={(e) => { setSearchText(e.target.value); debouncedApply(e.target.value); }}
            />
            <button className="btn" aria-label="篩選" onClick={() => setSheetOpen(true)}>
              <Icon name="filter" />
              篩選{activeFilterCount > 0 ? `（${activeFilterCount}）` : ''}
            </button>
          </div>
          {filter.q && (
            <p className="head-note">
              關鍵字「{filter.q}」支援繁簡對應。{' '}
              <button className="linkish" onClick={() => { setSearchText(''); applyFilter({ ...filter, q: '' }); }}>
                清除關鍵字
              </button>
            </p>
          )}
        </div>
      </header>

      {appliedChips.length > 0 && (
        <div className="applied">
          <span>
            篩選條件{filter.tagIds.length > 1 ? `（標籤：${filter.tagMode === 'all' ? '全部符合' : '任一符合'}）` : ''}
          </span>
          {appliedChips.map((c) => (
            <button key={c.key} className="applied-chip" onClick={c.remove} aria-label={`移除條件：${c.label}`}>
              {c.label}<span className="x" aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      {firstLoad && <SkeletonRows count={6} label="載入書庫" />}

      {!loading && failed && works.length === 0 && (
        <EmptyState
          title="書庫暫時載不出來"
          body="可能是連線中斷。重試一次通常就好；若持續失敗，稍後再回來看看。"
          action={<button className="btn" onClick={() => load(filter, null, false)}>重試</button>}
        />
      )}

      {!loading && !failed && works.length === 0 && (
        <EmptyState
          testId="catalog-empty"
          title="沒有符合條件的作品"
          body={
            appliedChips.length > 0 || filter.q
              ? '條件下沒有已發布的作品。試著移除一兩個條件，或換個關鍵字——搜尋同時比對繁體與簡體。'
              : '這個書庫由管理員維護，目前還沒有公開的作品。有新作發布時就會出現在這裡。'
          }
          action={appliedChips.length > 0 || filter.q
            ? (
              <button className="btn" onClick={() => { setSearchText(''); applyFilter({ ...filter, q: '', categoryIds: [], tagIds: [], serialStatus: [] }); }}>
                清除全部條件
              </button>
            )
            : undefined}
        />
      )}

      <div className="rows">
        {works.map((w) => <WorkCard key={w.id} work={w} onOpen={() => openDetail(w.id)} />)}
      </div>

      {loading && works.length > 0 && <SkeletonRows count={2} label="載入更多" />}

      {!done && !loading && works.length > 0 && (
        <button className="btn btn-block" onClick={() => load(filter, nextCursor, true)}>載入更多</button>
      )}

      <BottomSheet open={sheetOpen} title="篩選" onClose={() => setSheetOpen(false)}>
        <FilterSheet
          applied={filter}
          categories={categories}
          tags={tags}
          onApply={(next) => { applyFilter(next); setSheetOpen(false); }}
        />
      </BottomSheet>
    </div>
  );
}

// The panel edits a draft; 套用 promotes it to the applied filter and the URL,
// 清除 resets only the draft (keeping the type tab and the search string), and
// closing discards. Selections are marked with ✓ as well as colour (§21).
function FilterSheet({ applied, categories, tags, onApply }: {
  applied: CatalogFilterState;
  categories: TaxonomyItem[];
  tags: TaxonomyItem[];
  onApply(f: CatalogFilterState): void;
}) {
  const [draft, setDraft] = useState(applied);
  useEffect(() => { setDraft(applied); }, [applied]);

  const toggle = (list: string[], id: string) =>
    (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const chip = (selected: boolean) => `chip${selected ? ' selected' : ''}`;
  const mark = (selected: boolean) => (selected ? '✓ ' : '');

  return (
    <div data-testid="filter-sheet">
      <div className="setting-row">
        <span className="setting-label">排序</span>
        <div className="setting-control">
          {([['updated', '最近更新'], ['title', '書名']] as const).map(([v, label]) => (
            <button key={v} className={chip(draft.sort === v)} aria-pressed={draft.sort === v}
              onClick={() => setDraft({ ...draft, sort: v })}>{mark(draft.sort === v)}{label}</button>
          ))}
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-label">分類</span>
        <div className="setting-control">
          {categories.map((c) => (
            <button key={c.id} className={chip(draft.categoryIds.includes(c.id))}
              aria-pressed={draft.categoryIds.includes(c.id)}
              onClick={() => setDraft({ ...draft, categoryIds: toggle(draft.categoryIds, c.id) })}>
              {mark(draft.categoryIds.includes(c.id))}{c.displayName}
            </button>
          ))}
          {categories.length === 0 && <span className="muted">尚無分類</span>}
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-label">標籤</span>
        <div className="setting-control">
          {tags.map((t) => (
            <button key={t.id} className={chip(draft.tagIds.includes(t.id))}
              aria-pressed={draft.tagIds.includes(t.id)}
              onClick={() => setDraft({ ...draft, tagIds: toggle(draft.tagIds, t.id) })}>
              {mark(draft.tagIds.includes(t.id))}{t.displayName}
            </button>
          ))}
          {tags.length === 0 && <span className="muted">尚無標籤</span>}
        </div>
      </div>

      {draft.tagIds.length > 1 && (
        <div className="setting-row">
          <span className="setting-label">標籤模式</span>
          <div className="setting-control">
            {([['all', '全部符合'], ['any', '任一符合']] as const).map(([v, label]) => (
              <button key={v} className={chip(draft.tagMode === v)} aria-pressed={draft.tagMode === v}
                onClick={() => setDraft({ ...draft, tagMode: v })}>{mark(draft.tagMode === v)}{label}</button>
            ))}
          </div>
        </div>
      )}

      <div className="setting-row">
        <span className="setting-label">連載狀態</span>
        <div className="setting-control">
          {SERIAL_STATUS.map((s) => (
            <button key={s.v} className={chip(draft.serialStatus.includes(s.v))}
              aria-pressed={draft.serialStatus.includes(s.v)}
              onClick={() => setDraft({ ...draft, serialStatus: toggle(draft.serialStatus, s.v) })}>
              {mark(draft.serialStatus.includes(s.v))}{s.label}
            </button>
          ))}
        </div>
      </div>

      <p className="hint" style={{ marginTop: 'var(--sp-4)' }}>
        重設只清除面板內的分類、標籤與連載狀態，不會動到目前的類型與關鍵字。
      </p>

      <div className="sheet-actions">
        <button className="btn"
          onClick={() => setDraft({ ...draft, categoryIds: [], tagIds: [], tagMode: 'all', serialStatus: [] })}>
          清除篩選
        </button>
        <button className="btn primary" onClick={() => onApply(draft)}>套用</button>
      </div>
    </div>
  );
}
