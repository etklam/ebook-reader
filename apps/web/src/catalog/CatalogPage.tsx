// Public catalog (§21): mobile-first library home, set as an index of ruled
// rows. Applied filter state lives in the URL (§22) so a view is shareable and
// a reload restores it; the sheet edits a *draft* and only 套用 promotes it
// (§03A C). Totals are never invented: the list response deliberately returns
// total: null, so the header's count comes from /api/works/count, which runs
// the same predicate builder as the list and therefore always agrees with it
// (§03A-F). If that request fails the header falls back to what is loaded.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError, getCatalog, getCatalogCount, getPublicTaxonomy } from '../api/client.ts';
import type { CatalogWork, TaxonomyItem } from '../api/types.ts';
import { navigate } from '../App.tsx';
import { WorkCard } from './WorkCard.tsx';
import { BottomSheet } from '../reader/BottomSheet.tsx';
import { debounce } from '../reader/pagination.ts';
import { Icon } from '../components/Icon.tsx';
import { SkeletonRows } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { count } from '../lib/format.ts';
import { useMe } from '../account/useMe.ts';
import { workPath } from '../lib/slug.ts';
import { t } from '../i18n/translate.ts';

export interface CatalogFilterState {
  q: string;
  type: '' | 'short_story' | 'serial';
  categoryIds: string[];
  tagIds: string[];
  excludeTagIds: string[];
  hideFinished: boolean;
  tagMode: 'all' | 'any';
  serialStatus: string[];
  sort: 'updated' | 'title';
}

export function filterFromSearch(search: string): CatalogFilterState {
  const p = new URLSearchParams(search);
  const ids = (key: string) => [...new Set((p.get(key) ?? '').split(',').map((id) => id.trim().toLowerCase()).filter(Boolean))].sort();
  const excludeTagIds = ids('excludeTagIds');
  return {
    q: p.get('q') ?? '',
    type: (p.get('type') as CatalogFilterState['type']) ?? '',
    categoryIds: ids('categoryIds'),
    tagIds: ids('tagIds').filter((id) => !excludeTagIds.includes(id)),
    excludeTagIds,
    hideFinished: p.get('hideFinished') === 'true',
    tagMode: p.get('tagMode') === 'any' ? 'any' : 'all',
    serialStatus: (p.get('serialStatus') ?? '').split(',').filter(Boolean),
    sort: p.get('sort') === 'title' ? 'title' : 'updated',
  };
}

export function filterToSearch(f: CatalogFilterState): string {
  const p = new URLSearchParams();
  const ids = (values: string[]) => [...new Set(values.map((id) => id.toLowerCase()))].sort().join(',');
  if (f.q) p.set('q', f.q);
  if (f.type) p.set('type', f.type);
  if (f.categoryIds.length) p.set('categoryIds', ids(f.categoryIds));
  if (f.tagIds.length) p.set('tagIds', ids(f.tagIds));
  if (f.excludeTagIds.length) p.set('excludeTagIds', ids(f.excludeTagIds));
  if (f.hideFinished) p.set('hideFinished', 'true');
  if (f.tagIds.length && f.tagMode === 'any') p.set('tagMode', 'any');
  if (f.serialStatus.length) p.set('serialStatus', f.serialStatus.join(','));
  if (f.sort !== 'updated') p.set('sort', f.sort);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const PAGE = 20;

// Chip/tab labels keep the source string here and are translated where they
// are rendered: a module constant is evaluated once at import.
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
  const { me, loading: sessionLoading } = useMe();
  const [filter, setFilter] = useState(() => filterFromSearch(location.search));
  const [loadedWorks, setWorks] = useState<CatalogWork[]>([]);
  const [resultScope, setResultScope] = useState('');
  const [countScope, setCountScope] = useState('');
  const scope = `${me?.id ?? ''}:${filterToSearch(filter)}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const works = resultScope === scope ? loadedWorks : [];
  const [loginRequired, setLoginRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [categories, setCategories] = useState<TaxonomyItem[]>([]);
  const [tags, setTags] = useState<TaxonomyItem[]>([]);
  const [searchText, setSearchText] = useState(filter.q);
  const debouncedApply = useRef(debounce((q: string) => applyFilter({ ...filterRef.current, q }), 400)).current;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const seqRef = useRef(0);
  const countSeqRef = useRef(0);

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
    const requestScope = scopeRef.current;
    setLoading(true);
    if (!append) { setFailed(false); setLoginRequired(false); }
    const query = {
      q: f.q || undefined, type: f.type || undefined,
      categoryIds: f.categoryIds, tagIds: f.tagIds, tagMode: f.tagMode,
      excludeTagIds: f.excludeTagIds, hideFinished: f.hideFinished,
      serialStatus: f.serialStatus, sort: f.sort,
    };
    // the count belongs to the condition set, not to the page: it is fetched
    // once per condition change and left alone while paging deeper
    if (!append) {
      const countSeq = ++countSeqRef.current;
      setTotal(null);
      getCatalogCount(query)
        .then((r) => {
          // a count we cannot read is the same as no count: show the loaded
          // figure rather than the word "undefined"
          if (countSeq === countSeqRef.current && requestScope === scopeRef.current) {
            setTotal(typeof r.count === 'number' ? r.count : null);
            setCountScope(requestScope);
          }
        })
        .catch(() => undefined);
    }
    getCatalog({ ...query, limit: PAGE, cursor: cursor ?? undefined }).then((r) => {
      if (seq !== seqRef.current || requestScope !== scopeRef.current) return;   // a newer condition already won
      setResultScope(requestScope);
      setWorks((prev) => (append ? [...prev, ...r.works] : r.works));
      setNextCursor(r.nextCursor);
      setDone(r.nextCursor === null);
    }).catch((error: unknown) => {
      if (seq !== seqRef.current || requestScope !== scopeRef.current) return;
      if (!append) setWorks([]);
      setFailed(true);
      setLoginRequired(error instanceof ApiRequestError && error.status === 401 && f.hideFinished);
    }).finally(() => {
      if (seq === seqRef.current) setLoading(false);
    });
  }, []);

  // a changed condition set always restarts from no cursor (§03A-C)
  useEffect(() => {
    // Invalidate in-flight responses and cursors on login, logout, or account
    // changes, even while the same URL/filter remains selected.
    ++seqRef.current;
    ++countSeqRef.current;
    setWorks([]);
    setNextCursor(null);
    setTotal(null);
    if (sessionLoading) return;
    if (filter.hideFinished && !me?.id) {
      setLoading(false);
      setFailed(false);
      setLoginRequired(true);
      return;
    }
    load(filter, null, false);
  }, [filter, me?.id, sessionLoading, load]);

  // the filter query string rides along so 返回 lands on the same catalogue view
  const openDetail = (work: CatalogWork) => navigate(workPath(work) + location.search);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.id, c.displayName);
    for (const t of tags) m.set(t.id, t.displayName);
    return (id: string) => m.get(id) ?? t('（已停用條件）');
  }, [categories, tags]);

  const activeFilterCount =
    filter.categoryIds.length + filter.tagIds.length + filter.excludeTagIds.length + filter.serialStatus.length + Number(filter.hideFinished);

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
    ...filter.excludeTagIds.map((id) => ({
      key: `exclude:${id}`,
      label: t('排除 #{name}', { name: nameOf(id) }),
      remove: () => applyFilter({ ...filter, excludeTagIds: filter.excludeTagIds.filter((x) => x !== id) }),
    })),
    ...(filter.hideFinished ? [{ key: 'hideFinished', label: t('隱藏已讀'), remove: () => applyFilter({ ...filter, hideFinished: false }) }] : []),
    ...filter.serialStatus.map((v) => ({
      key: `s:${v}`,
      label: (() => { const hit = SERIAL_STATUS.find((s) => s.v === v); return hit ? t(hit.label) : v; })(),
      remove: () => applyFilter({ ...filter, serialStatus: filter.serialStatus.filter((x) => x !== v) }),
    })),
  ];

  const firstLoad = (loading || sessionLoading) && works.length === 0;
  const visibleTotal = countScope === scope ? total : null;

  // the head states the size of the shelf under these conditions; how much of
  // it is on screen belongs to the 載入更多 button, where it is actionable
  const headNote = firstLoad ? t('載入中')
    : visibleTotal === null ? t('已載入 {n} 部', { n: count(works.length) })
    : t('共 {n} 部', { n: count(visibleTotal) });

  return (
    <div className="catalog" data-testid="catalog">
      <header className="page-head">
        <div className="head-line">
          <h1>{t('書庫')}</h1>
          <span className="head-note tnum">{headNote}　<button className="linkish" onClick={() => navigate('/rankings')}>{t('排行榜')}</button></span>
        </div>
        <div className="seg" role="tablist" aria-label={t('作品類型')}>
          {TYPE_TABS.map((tab) => (
            <button
              key={tab.v}
              role="tab"
              aria-selected={filter.type === tab.v}
              className="seg-item"
              onClick={() => applyFilter({ ...filter, type: tab.v as CatalogFilterState['type'] })}
            >
              {t(tab.label)}
            </button>
          ))}
        </div>
        <div className="catalog-tools">
          <div className="search-row">
            <input
              className="input"
              type="search"
              placeholder={t('搜尋書名、作者、分類、標籤')}
              aria-label={t('搜尋')}
              value={searchText}
              onChange={(e) => { setSearchText(e.target.value); debouncedApply(e.target.value); }}
            />
            <button className="btn" aria-label={t('篩選')} onClick={() => setSheetOpen(true)}>
              <Icon name="filter" />
              {activeFilterCount > 0 ? t('篩選（{n}）', { n: activeFilterCount }) : t('篩選')}
            </button>
          </div>
          {filter.q && (
            <p className="head-note">
              {t('關鍵字「{q}」支援繁簡對應。', { q: filter.q })}{' '}
              <button className="linkish" onClick={() => { setSearchText(''); applyFilter({ ...filter, q: '' }); }}>
                {t('清除關鍵字')}
              </button>
            </p>
          )}
        </div>
      </header>

      {appliedChips.length > 0 && (
        <div className="applied">
          <span>
            {filter.tagIds.length > 1
              ? t('篩選條件（標籤：{mode}）', { mode: filter.tagMode === 'all' ? t('全部符合') : t('任一符合') })
              : t('篩選條件')}
          </span>
          {appliedChips.map((c) => (
            <button key={c.key} className="applied-chip" onClick={c.remove} aria-label={t('移除條件：{label}', { label: c.label })}>
              {c.label}<span className="x" aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      {firstLoad && <SkeletonRows count={6} label={t('載入書庫')} />}

      {!firstLoad && loginRequired && (
        <EmptyState title={t('登入後才能隱藏已讀')} body={t('此條件只使用本人書架手動標記為「已讀」的作品。登入後可繼續，或移除此條件。')}
          action={<button className="btn" onClick={() => navigate('/login')}>{t('登入')}</button>} />
      )}

      {!loading && !loginRequired && failed && works.length === 0 && (
        <EmptyState
          title={t('書庫暫時載不出來')}
          body={t('可能是連線中斷。重試一次通常就好；若持續失敗，稍後再回來看看。')}
          action={<button className="btn" onClick={() => load(filter, null, false)}>{t('重試')}</button>}
        />
      )}

      {!firstLoad && !loginRequired && !failed && works.length === 0 && (
        <EmptyState
          testId="catalog-empty"
          title={t('沒有符合條件的作品')}
          body={
            appliedChips.length > 0 || filter.q
              ? t('條件下沒有已發布的作品。試著移除一兩個條件，或換個關鍵字——搜尋同時比對繁體與簡體。')
              : t('這個書庫由管理員維護，目前還沒有公開的作品。有新作發布時就會出現在這裡。')
          }
          action={appliedChips.length > 0 || filter.q
            ? (
              <button className="btn" onClick={() => { setSearchText(''); applyFilter({ ...filter, q: '', categoryIds: [], tagIds: [], excludeTagIds: [], hideFinished: false, serialStatus: [] }); }}>
                {t('清除全部條件')}
              </button>
            )
            : undefined}
        />
      )}

      <div className="rows">
        {works.map((w) => <WorkCard key={w.id} work={w} onOpen={() => openDetail(w)} />)}
      </div>

      {loading && works.length > 0 && <SkeletonRows count={2} label={t('載入更多')} />}

      {!done && !loading && works.length > 0 && (
        <button className="btn btn-block tnum" onClick={() => load(filter, nextCursor, true)}>
          {visibleTotal === null
            ? t('載入更多')
            : t('載入更多（{loaded} / {total}）', { loaded: count(works.length), total: count(visibleTotal) })}
        </button>
      )}

      <BottomSheet open={sheetOpen} title={t('篩選')} onClose={() => setSheetOpen(false)}>
        <FilterSheet
          applied={filter}
          signedIn={!!me}
          sessionLoading={sessionLoading}
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
function FilterSheet({ applied, signedIn, sessionLoading, categories, tags, onApply }: {
  applied: CatalogFilterState;
  signedIn: boolean;
  sessionLoading: boolean;
  categories: TaxonomyItem[];
  tags: TaxonomyItem[];
  onApply(f: CatalogFilterState): void;
}) {
  const [draft, setDraft] = useState(applied);
  const [tagFeedback, setTagFeedback] = useState('');
  useEffect(() => { setDraft(applied); }, [applied]);

  const toggle = (list: string[], id: string) =>
    (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const chip = (selected: boolean) => `chip${selected ? ' selected' : ''}`;
  const mark = (selected: boolean) => (selected ? '✓ ' : '');

  return (
    <div data-testid="filter-sheet">
      <div className="setting-row">
        <span className="setting-label">{t('排序')}</span>
        <div className="setting-control">
          {([['updated', '最近更新'], ['title', '書名']] as const).map(([v, label]) => (
            <button key={v} className={chip(draft.sort === v)} aria-pressed={draft.sort === v}
              onClick={() => setDraft({ ...draft, sort: v })}>{mark(draft.sort === v)}{t(label)}</button>
          ))}
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-label">{t('分類')}</span>
        <div className="setting-control">
          {categories.map((c) => (
            <button key={c.id} className={chip(draft.categoryIds.includes(c.id))}
              aria-pressed={draft.categoryIds.includes(c.id)}
              onClick={() => setDraft({ ...draft, categoryIds: toggle(draft.categoryIds, c.id) })}>
              {mark(draft.categoryIds.includes(c.id))}{c.displayName}
            </button>
          ))}
          {categories.length === 0 && <span className="muted">{t('尚無分類')}</span>}
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-label">{t('標籤')}</span>
        <div className="setting-control">
          {tags.map((tag) => {
            const included = draft.tagIds.includes(tag.id);
            const excluded = draft.excludeTagIds.includes(tag.id);
            return (
              <button key={tag.id} className={chip(included || excluded)}
                aria-label={t('{name}：{state}', {
                  name: tag.displayName,
                  state: included ? t('包含，改為排除') : excluded ? t('排除，改為不篩選') : t('不篩選，改為包含'),
                })}
                aria-pressed={included || excluded}
                onClick={() => {
                  setDraft({ ...draft,
                    tagIds: !included && !excluded ? [...draft.tagIds, tag.id] : draft.tagIds.filter((id) => id !== tag.id),
                    excludeTagIds: included ? [...draft.excludeTagIds, tag.id] : draft.excludeTagIds.filter((id) => id !== tag.id),
                  });
                  setTagFeedback(t('{name}：{state}', {
                    name: tag.displayName,
                    state: included ? t('已由包含改為排除') : excluded ? t('已移除排除條件') : t('已設為包含'),
                  }));
                }}>
                {included ? '✓ ' : excluded ? `${t('排除')} ` : ''}{tag.displayName}{included ? t('（包含）') : ''}
              </button>
            );
          })}
          {tags.length === 0 && <span className="muted">{t('尚無標籤')}</span>}
        </div>
      </div>

      <p className="hint sheet-hint">{t('標籤依序切換：不篩選 → 包含 → 排除。命中任一排除標籤即隱藏。')}</p>
      <p className="hint sheet-hint" role="status">{tagFeedback}</p>

      {draft.tagIds.length > 1 && (
        <div className="setting-row">
          <span className="setting-label">{t('標籤模式')}</span>
          <div className="setting-control">
            {([['all', '全部符合'], ['any', '任一符合']] as const).map(([v, label]) => (
              <button key={v} className={chip(draft.tagMode === v)} aria-pressed={draft.tagMode === v}
                onClick={() => setDraft({ ...draft, tagMode: v })}>{mark(draft.tagMode === v)}{t(label)}</button>
            ))}
          </div>
        </div>
      )}

      <div className="setting-row">
        <span className="setting-label">{t('連載狀態')}</span>
        <div className="setting-control">
          {SERIAL_STATUS.map((s) => (
            <button key={s.v} className={chip(draft.serialStatus.includes(s.v))}
              aria-pressed={draft.serialStatus.includes(s.v)}
              onClick={() => setDraft({ ...draft, serialStatus: toggle(draft.serialStatus, s.v) })}>
              {mark(draft.serialStatus.includes(s.v))}{t(s.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-label">{t('閱讀狀態')}</span>
        <div className="setting-control">
          <label className="chip">
            <input type="checkbox" checked={draft.hideFinished} disabled={!signedIn || sessionLoading}
              onChange={(e) => setDraft({ ...draft, hideFinished: e.target.checked })} />
            {t('隱藏已讀')}
          </label>
          {!signedIn && !sessionLoading && <button className="linkish" onClick={() => navigate('/login')}>{t('登入後使用')}</button>}
        </div>
      </div>
      <p className="hint sheet-hint">{t('只隱藏本人書架手動標記為「已讀」的作品；閱讀進度不會自動視為已讀。')}</p>

      <p className="hint sheet-hint">
        {t('重設只清除面板內的分類、包含與排除標籤、連載狀態與隱藏已讀，不會動到目前的類型與關鍵字。')}
      </p>

      <div className="sheet-actions">
        <button className="btn"
          onClick={() => setDraft({ ...draft, categoryIds: [], tagIds: [], excludeTagIds: [], hideFinished: false, tagMode: 'all', serialStatus: [] })}>
          {t('清除篩選')}
        </button>
        <button className="btn primary" onClick={() => onApply(draft)}>{t('套用')}</button>
      </div>
    </div>
  );
}
