// One taxonomy cache for every admin surface. Import, publish and the taxonomy
// tab all read it, so a category created mid-import appears everywhere at once
// instead of needing a page reload (the old BatchImportPanel failure mode).
import { useEffect, useSyncExternalStore } from 'react';
import { ApiRequestError, api, getCategories, getTags } from '../api/client.ts';
import type { TaxonomyItem, TaxonomyListResponse } from '../api/types.ts';
import { t } from '../i18n/translate.ts';

export type TaxonomyKind = 'categories' | 'tags';

export interface TaxonomySnapshot {
  categories: TaxonomyItem[];
  tags: TaxonomyItem[];
  loaded: boolean;
  error: string;
}

const EMPTY: TaxonomySnapshot = { categories: [], tags: [], loaded: false, error: '' };
let snapshot: TaxonomySnapshot = EMPTY;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(patch: Partial<TaxonomySnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Inactive items are fetched too: they can't be newly assigned, but a work may
// already carry one and hiding it would make the selection look wrong.
export function loadTaxonomy(force = false): Promise<void> {
  if (inflight) return inflight;
  if (snapshot.loaded && !force) return Promise.resolve();
  inflight = Promise.all([getCategories(true), getTags(true)])
    .then(([categories, tags]: TaxonomyListResponse[]) =>
      publish({ categories: categories.items, tags: tags.items, loaded: true, error: '' }))
    .catch(() => publish({ error: t('無法載入分類與標籤。請按「重新載入詞庫」再試。') }))
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * Create a category/tag and fold it into the cache. A duplicate name is not an
 * error for the caller — the point is to end up with the item, so the existing
 * row is returned instead.
 */
export async function createTaxonomyItem(kind: TaxonomyKind, displayName: string): Promise<TaxonomyItem> {
  const name = displayName.trim();
  if (!name) throw new Error(t('名稱必填'));
  try {
    const created = await api<TaxonomyItem>(`/api/admin/taxonomy/${kind}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
    });
    publish({ [kind]: [...snapshot[kind], created] } as Partial<TaxonomySnapshot>);
    return created;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      await loadTaxonomy(true);
      const existing = snapshot[kind].find((item) => item.displayName === name);
      if (existing) return existing;
    }
    throw error;
  }
}

export function useTaxonomy(): TaxonomySnapshot & {
  reload(): Promise<void>;
  create(kind: TaxonomyKind, displayName: string): Promise<TaxonomyItem>;
} {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => { void loadTaxonomy(); }, []);
  return { ...state, reload: () => loadTaxonomy(true), create: createTaxonomyItem };
}

/** Test seam: the module cache outlives a component tree. */
export function resetTaxonomyCache(): void {
  snapshot = EMPTY;
  inflight = null;
}
