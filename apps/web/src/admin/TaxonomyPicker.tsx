// Shared category/tag picker for every admin surface that classifies a work.
// Three affordances in one control: the current selection, a searchable list of
// what exists, and the source's own keywords as one-click suggestions.
import { useMemo, useState } from 'react';
import type { TaxonomyItem } from '../api/types.ts';
import { matchesQuery, suggestTaxonomy } from './taxonomy-suggest.ts';
import { useTaxonomy, type TaxonomyKind } from './useTaxonomy.ts';
import { t } from '../i18n/translate.ts';

export const MAX_CATEGORIES = 5;
export const MAX_TAGS = 20;

export interface TaxonomySelection { categoryIds: string[]; tagIds: string[] }

const LIMITS: Record<TaxonomyKind, number> = { categories: MAX_CATEGORIES, tags: MAX_TAGS };
// a function, not a constant: it has to follow a locale switch
const unit = (kind: TaxonomyKind): string => t(kind === 'categories' ? '分類' : '標籤');
// stable identity: a fresh [] default would re-run the suggestion memo every render
const NO_KEYWORDS: readonly string[] = [];

function fieldOf(kind: TaxonomyKind): keyof TaxonomySelection {
  return kind === 'categories' ? 'categoryIds' : 'tagIds';
}

export function TaxonomyPicker({
  value, onChange, keywords = NO_KEYWORDS, disabled = false, idPrefix, compact = false,
}: {
  value: TaxonomySelection;
  onChange(next: TaxonomySelection): void;
  /** Raw keywords parsed from the source file, offered as suggestions. */
  keywords?: readonly string[];
  disabled?: boolean;
  idPrefix: string;
  /** Collapses the browse lists behind a toggle — for dense batch rows. */
  compact?: boolean;
}) {
  const taxonomy = useTaxonomy();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(!compact);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');

  const suggestions = useMemo(
    () => suggestTaxonomy(keywords, taxonomy.categories, taxonomy.tags),
    [keywords, taxonomy.categories, taxonomy.tags],
  );

  const selectedIn = (kind: TaxonomyKind) => value[fieldOf(kind)];
  const itemsIn = (kind: TaxonomyKind) => taxonomy[kind];
  const isSelected = (kind: TaxonomyKind, id: string) => selectedIn(kind).includes(id);
  const atLimit = (kind: TaxonomyKind) => selectedIn(kind).length >= LIMITS[kind];

  function toggle(kind: TaxonomyKind, item: TaxonomyItem): void {
    if (disabled) return;
    const field = fieldOf(kind);
    const current = value[field];
    if (current.includes(item.id)) {
      onChange({ ...value, [field]: current.filter((id) => id !== item.id) });
      return;
    }
    // Deactivated items may stay on a work that already has them, but adding
    // one now would just fail the publish check later.
    if (!item.isActive) { setError(t('「{name}」已停用，不能新指派。', { name: item.displayName })); return; }
    if (current.length >= LIMITS[kind]) {
      setError(t('{unit}最多 {limit} 個；請先取消一個。', { unit: unit(kind), limit: LIMITS[kind] }));
      return;
    }
    setError('');
    onChange({ ...value, [field]: [...current, item.id] });
  }

  async function createAndSelect(kind: TaxonomyKind, name: string): Promise<void> {
    if (disabled || !name.trim()) return;
    if (atLimit(kind)) { setError(t('{unit}最多 {limit} 個；請先取消一個。', { unit: unit(kind), limit: LIMITS[kind] })); return; }
    setPending(`${kind}:${name}`); setError('');
    try {
      const created = await taxonomy.create(kind, name);
      const field = fieldOf(kind);
      if (!value[field].includes(created.id)) onChange({ ...value, [field]: [...value[field], created.id] });
      setQuery('');
    } catch {
      setError(t('無法建立{unit}「{name}」。請改到「分類標籤」建立後再回來。', { unit: unit(kind), name }));
    } finally { setPending(''); }
  }

  const unmatched = suggestions.filter((s) => !s.match);
  const unusedSuggestions = suggestions.filter((s) => s.match && !isSelected(s.kind, s.match.id));

  const chipList = (kind: TaxonomyKind) => {
    const visible = itemsIn(kind).filter((item) =>
      matchesQuery(item, query) && (item.isActive || isSelected(kind, item.id)));
    const exactExists = itemsIn(kind).some((item) => item.displayName === query.trim());
    return (
      <div className="taxonomy-group">
        <div className="taxonomy-group-head">
          <span id={`${idPrefix}-${kind}-label`}>
            {unit(kind)}
            <span className="hint tnum">　{selectedIn(kind).length} / {LIMITS[kind]}</span>
          </span>
        </div>
        <div className="taxonomy-chips" role="group" aria-labelledby={`${idPrefix}-${kind}-label`}>
          {visible.map((item) => {
            const on = isSelected(kind, item.id);
            return (
              <button type="button" key={item.id} aria-pressed={on} disabled={disabled}
                className={`chip${on ? ' selected' : ''}${item.isActive ? '' : ' chip-retired'}`}
                title={item.description || undefined}
                onClick={() => toggle(kind, item)}>
                {on ? '✓ ' : ''}{item.displayName}{item.isActive ? '' : t('（已停用）')}
              </button>
            );
          })}
          {visible.length === 0 && (
            <span className="muted">{query
              ? t('沒有符合「{query}」的{unit}', { query, unit: unit(kind) })
              : t('尚無{unit}', { unit: unit(kind) })}</span>
          )}
          {query.trim() && !exactExists && !disabled && (
            <button type="button" className="chip chip-create" disabled={!!pending}
              onClick={() => void createAndSelect(kind, query.trim())}>
              ＋ {t('新增{unit}「{name}」', { unit: unit(kind), name: query.trim() })}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="taxonomy-picker" data-testid={`${idPrefix}-taxonomy`}>
      {taxonomy.error && (
        <p className="form-error" role="alert">
          {taxonomy.error}
          <button type="button" className="linkish" onClick={() => void taxonomy.reload()}>{t('重新載入詞庫')}</button>
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="taxonomy-suggestions">
          <p className="hint">
            {t('來源檔案註明的分類／標籤（{n} 項）。點一下採用；未採用的不會寫入。', { n: suggestions.length })}
          </p>
          <div className="taxonomy-chips">
            {unusedSuggestions.map((suggestion) => (
              <button type="button" key={`m-${suggestion.match!.id}`} className="chip chip-suggested" disabled={disabled}
                onClick={() => toggle(suggestion.kind, suggestion.match!)}>
                ＋ {suggestion.match!.displayName}
                <span className="hint">　{unit(suggestion.kind)}</span>
              </button>
            ))}
            {unmatched.map((suggestion) => (
              <button type="button" key={`n-${suggestion.keyword}`} className="chip chip-create"
                disabled={disabled || !!pending}
                onClick={() => void createAndSelect('tags', suggestion.keyword)}>
                {pending === `tags:${suggestion.keyword}` ? t('建立中…') : `＋ ${t('建立標籤「{name}」', { name: suggestion.keyword })}`}
              </button>
            ))}
            {unusedSuggestions.length === 0 && unmatched.length === 0 && (
              <span className="muted">{t('來源建議的項目都已採用。')}</span>
            )}
          </div>
        </div>
      )}

      {compact && (
        <button type="button" className="linkish" onClick={() => setOpen((v) => !v)}>
          {open
            ? t('收起分類與標籤')
            : t('選擇分類與標籤（已選 {categories} 分類、{tags} 標籤）', { categories: value.categoryIds.length, tags: value.tagIds.length })}
        </button>
      )}

      {open && (
        <>
          <div className="field">
            <label htmlFor={`${idPrefix}-taxonomy-search`}>{t('搜尋分類或標籤')}</label>
            <input className="input" id={`${idPrefix}-taxonomy-search`} type="search" value={query}
              disabled={disabled} placeholder={t('輸入關鍵字；沒有的可直接新增')}
              // this picker is embedded in the import and draft forms; Enter
              // here means "filter", never "submit the whole import"
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
              onChange={(e) => { setQuery(e.target.value); setError(''); }} />
          </div>
          {!taxonomy.loaded && !taxonomy.error
            ? <p className="hint" role="status">{t('載入分類與標籤…')}</p>
            : <>{chipList('categories')}{chipList('tags')}</>}
        </>
      )}

      {error && <p className="form-warn" role="alert">{error}</p>}
    </div>
  );
}
