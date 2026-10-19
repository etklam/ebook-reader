// Shared API client: same-origin credentials, JSON parsing, typed errors.
// Member state endpoints throw ProgressConflict so the reader can resolve.
export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, public body?: unknown) {
    super(`api ${status}: ${code}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string };
    throw new ApiRequestError(res.status, b.error ?? 'unknown_error', body);
  }
  return body as T;
}

const json = (method: string, body: unknown, extra?: RequestInit): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  ...extra,
});

import type {
  BookmarksResponse, CatalogResponse, FollowEntry, LibraryEntry, Me, PublishPreviewResponse,
  PublishResponse, ReaderChapter, ReaderPreferencesDto, ReaderWork, ServerProgress,
  TaxonomyListResponse, TocResponse, WorkDetail, WorkMemberState,
} from './types.ts';

// --- session -------------------------------------------------------------------
export const getMe = () => api<{ user: Me | null }>('/api/me');
export const login = (email: string, password: string) => api<{ ok: true }>('/api/auth/login', json('POST', { email, password }));
export const logout = () => api<{ ok: true }>('/api/auth/logout', json('POST', {}));
export const register = (username: string, email: string, password: string, invite: string) =>
  api<{ ok: true }>('/api/auth/register', json('POST', { username, email, password, invite }));

// --- catalog -------------------------------------------------------------------
export interface CatalogQuery {
  q?: string; type?: string; categoryIds?: string[]; tagIds?: string[];
  excludeTagIds?: string[]; hideFinished?: boolean;
  tagMode?: 'all' | 'any'; serialStatus?: string[]; sort?: string; limit?: number;
  /** opaque keyset cursor from a previous response's nextCursor */
  cursor?: string;
}

export function catalogQueryString(query: CatalogQuery): string {
  const p = new URLSearchParams();
  if (query.q) p.set('q', query.q);
  if (query.type) p.set('type', query.type);
  if (query.categoryIds?.length) p.set('categoryIds', query.categoryIds.join(','));
  if (query.tagIds?.length) p.set('tagIds', query.tagIds.join(','));
  if (query.excludeTagIds?.length) p.set('excludeTagIds', [...new Set(query.excludeTagIds)].sort().join(','));
  if (query.hideFinished) p.set('hideFinished', 'true');
  if (query.tagIds?.length && query.tagMode) p.set('tagMode', query.tagMode);
  if (query.serialStatus?.length) p.set('serialStatus', query.serialStatus.join(','));
  if (query.sort) p.set('sort', query.sort);
  if (query.limit !== undefined) p.set('limit', String(query.limit));
  if (query.cursor) p.set('cursor', query.cursor);
  return p.toString();
}

export const getCatalog = (query: CatalogQuery) => api<CatalogResponse>(`/api/works?${catalogQueryString(query)}`, { cache: 'no-store' });
// takes the same filters as getCatalog — the server applies one shared
// predicate builder, so a count without the active filters would disagree with
// the list it is meant to describe (§03A-F)
export const getCatalogCount = (query: CatalogQuery = {}) => {
  const { limit: _l, cursor: _c, ...filters } = query;
  const qs = catalogQueryString(filters);
  return api<{ count: number }>(`/api/works/count${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
};
export const getWorkDetail = (id: string) => api<WorkDetail>(`/api/works/${encodeURIComponent(id)}`);

// --- public reader ---------------------------------------------------------------
export const getWork = (id: string) => api<ReaderWork>(`/api/reader/works/${encodeURIComponent(id)}`);
export const getToc = (id: string, limit: number, offset: number, options: {
  aroundChapterId?: string; latest?: boolean; q?: string; order?: 'asc' | 'desc'; version?: string;
} = {}) => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
  return api<TocResponse>(`/api/reader/works/${encodeURIComponent(id)}/chapters?${params}`);
};
// `work` is only needed when `id` is a chapter public id, which is unique per
// work rather than globally (server/src/db/schema.ts). Internal navigation
// passes uuids and needs nothing; the first load from a slug URL passes both.
export const getChapter = (id: string, work?: string) =>
  api<ReaderChapter>(`/api/reader/chapters/${encodeURIComponent(id)}${work ? `?work=${encodeURIComponent(work)}` : ''}`);

// --- member state ------------------------------------------------------------------
export const getLibrary = (cursor?: string, filters: import('./types.ts').LibraryFilters = {}) => {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (filters.readingStatus) params.set('readingStatus', filters.readingStatus);
  if (filters.groupName !== undefined) params.set('groupName', filters.groupName);
  return api<{ limit: number; nextCursor: string | null; works: LibraryEntry[]; groups: string[] }>(`/api/me/library?${params}`);
};
export const updateLibraryEntry = (workId: string, patch: { readingStatus?: import('./types.ts').LibraryReadingStatus; groupName?: string | null }) =>
  api<{ ok: true }>(`/api/me/library/${workId}`, json('PATCH', patch));
// one-work state for the detail page — cheaper and correct now that the
// library is paginated (fetching page 1 would miss a work further down)
export const getWorkMemberState = (workId: string) =>
  api<WorkMemberState>(`/api/me/works/${workId}/state`);
export const addToLibrary = (workId: string) => api<{ ok: true }>(`/api/me/library/${workId}`, json('PUT', {}));
export const removeFromLibrary = (workId: string) => api<{ ok: true }>(`/api/me/library/${workId}`, { method: 'DELETE' });
export const getFollows = () => api<{ follows: FollowEntry[] }>('/api/me/follows');
export const follow = (workId: string) => api<{ ok: true }>(`/api/me/follows/${workId}`, json('PUT', {}));
export const unfollow = (workId: string) => api<{ ok: true }>(`/api/me/follows/${workId}`, { method: 'DELETE' });
export const markFollowSeen = (workId: string, releaseVersion?: number) =>
  api<{ ok: true }>(`/api/me/follows/${workId}/seen`, json('POST', releaseVersion === undefined ? {} : { releaseVersion }));

export const getProgress = (workId: string) => api<{ progress: ServerProgress | null }>(`/api/me/progress/${workId}`);
export const saveProgress = (workId: string, body: {
  chapterId: string; revisionId: string; paragraphIndex: number; fraction?: number | null; baseVersion: number;
}) => api<{ ok: true; syncVersion: number }>(`/api/me/progress/${workId}`, json('PUT', body));

export const markRead = (chapterId: string) => api<{ ok: true }>('/api/me/reads', json('POST', { chapterId }));
export const getReads = (workId: string) => api<{ reads: Array<{ chapterId: string; lastReadAt: string }> }>(`/api/me/reads?workId=${workId}`);

export const getBookmarks = (workId?: string, offset = 0) => {
  const params = new URLSearchParams({ limit: '100', offset: String(offset) });
  if (workId) params.set('workId', workId);
  return api<BookmarksResponse>(`/api/me/bookmarks?${params}`);
};
export const updateBookmarkNote = (id: string, note: string) =>
  api<{ ok: true }>(`/api/me/bookmarks/${id}`, json('PATCH', { note }));
export const createBookmark = (body: { workId: string; chapterId: string; revisionId: string; paragraphIndex: number; note?: string }) =>
  api<{ id: string }>('/api/me/bookmarks', json('POST', body));
export const deleteBookmark = (id: string) => api<{ ok: true }>(`/api/me/bookmarks/${id}`, { method: 'DELETE' });

export const getReaderPreferences = () => api<{ preferences: ReaderPreferencesDto | null }>('/api/me/reader-preferences');
export const saveReaderPreferences = (p: Omit<ReaderPreferencesDto, 'updatedAt'>) =>
  api<{ ok: true }>('/api/me/reader-preferences', json('PUT', p));

// --- taxonomy: public lists for the filter sheet; admin CRUD via adminApi ----
export const getPublicTaxonomy = (kind: 'categories' | 'tags') =>
  api<{ items: Array<{ id: string; displayName: string }> }>(`/api/taxonomy/${kind}`);
export const getCategories = (includeInactive = false) =>
  api<TaxonomyListResponse>(`/api/admin/taxonomy/categories?includeInactive=${includeInactive ? 1 : 0}`);
export const getTags = (includeInactive = false) =>
  api<TaxonomyListResponse>(`/api/admin/taxonomy/tags?includeInactive=${includeInactive ? 1 : 0}`);

// --- admin publishing ----------------------------------------------------------------
export const getPublishPreview = (workId: string) =>
  api<PublishPreviewResponse>(`/api/admin/works/${workId}/publish-preview`);
export const publishWork = (workId: string, idempotencyKey: string, note = '') =>
  api<PublishResponse>(`/api/admin/works/${workId}/publish`, json('POST', { note }, { headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey } }));

export const getRankings = (period: import('./types.ts').RankingPeriod, type: import('./types.ts').RankingType = 'clicks', filters: import('./types.ts').RankingFilters = {}) => {
  const params = new URLSearchParams({ period, type });
  if (filters.serialStatus) params.set('serialStatus', filters.serialStatus);
  if (filters.categoryId) params.set('categoryId', filters.categoryId);
  return api<import('./types.ts').RankingResponse>(`/api/rankings?${params}`);
};
export const getRelatedWorks = (workId: string) =>
  api<{ works: import('./types.ts').RelatedWork[] }>(`/api/works/${workId}/related`);
export const recordWorkClick = (workId: string) =>
  api<{ counted: boolean }>(`/api/works/${workId}/click`, json('POST', {}));

// --- import monitoring ---------------------------------------------------------
export const getImportJob = (id: string, signal?: AbortSignal) =>
  api<import('./import-types.ts').ImportJob>(`/api/admin/imports/${id}`, { signal });
export const getImportQuality = (id: string, signal?: AbortSignal) =>
  api<import('./import-types.ts').ImportQuality>(`/api/admin/imports/${id}/quality`, { signal });
