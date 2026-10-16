// Maps raw source keywords (EPUB dc:subject, TXT 分類／標籤 front matter) onto
// the existing taxonomy. Matching is deliberately conservative: an exact
// normalized name or nothing. A near-miss silently assigning the wrong
// category is worse than showing the admin an unmatched word to create.
import type { TaxonomyItem } from '../api/types.ts';
import type { TaxonomyKind } from './useTaxonomy.ts';

export interface TaxonomySuggestion {
  keyword: string;
  /** The existing item this keyword names, or null when nothing matches. */
  match: TaxonomyItem | null;
  /** Where the match was found, or where a one-click create would put it. */
  kind: TaxonomyKind;
}

export function normalizeTaxonomyName(value: string): string {
  return value.trim().toLowerCase()
    .replace(/[\s_\-·・.。,，、/／|｜()（）[\]【】]/g, '');
}

function index(items: TaxonomyItem[]): Map<string, TaxonomyItem> {
  const byName = new Map<string, TaxonomyItem>();
  for (const item of items) {
    const key = normalizeTaxonomyName(item.displayName);
    // first wins: the list arrives in sortOrder, so the canonical item is first
    if (key && !byName.has(key)) byName.set(key, item);
  }
  return byName;
}

/**
 * Categories are checked before tags because a source genre word ("玄幻") is
 * far more often a category. Unmatched keywords default to tags — the open,
 * low-stakes side of the taxonomy.
 */
export function suggestTaxonomy(
  keywords: readonly string[],
  categories: TaxonomyItem[],
  tags: TaxonomyItem[],
): TaxonomySuggestion[] {
  const categoryIndex = index(categories);
  const tagIndex = index(tags);
  const suggestions: TaxonomySuggestion[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const key = normalizeTaxonomyName(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const category = categoryIndex.get(key);
    if (category) { suggestions.push({ keyword, match: category, kind: 'categories' }); continue; }
    const tag = tagIndex.get(key);
    suggestions.push(tag ? { keyword, match: tag, kind: 'tags' } : { keyword, match: null, kind: 'tags' });
  }
  return suggestions;
}

/** Case/width-insensitive contains, for the picker's search box. */
export function matchesQuery(item: TaxonomyItem, query: string): boolean {
  const needle = normalizeTaxonomyName(query);
  if (!needle) return true;
  return normalizeTaxonomyName(item.displayName).includes(needle) ||
    normalizeTaxonomyName(item.description).includes(needle);
}
