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
  BookmarkEntry, CatalogResponse, FollowEntry, LibraryEntry, Me, PublishPreviewResponse,
  PublishResponse, ReaderChapter, ReaderPreferencesDto, ReaderWork, ServerProgress,
  TaxonomyListResponse, TocResponse, WorkDetail,
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
  tagMode?: 'all' | 'any'; serialStatus?: string[]; sort?: string; limit?: number; offset?: number;
}

export function catalogQueryString(query: CatalogQuery): string {
  const p = new URLSearchParams();
  if (query.q) p.set('q', query.q);
  if (query.type) p.set('type', query.type);
  if (query.categoryIds?.length) p.set('categoryIds', query.categoryIds.join(','));
  if (query.tagIds?.length) p.set('tagIds', query.tagIds.join(','));
  if (query.tagIds?.length && query.tagMode) p.set('tagMode', query.tagMode);
  if (query.serialStatus?.length) p.set('serialStatus', query.serialStatus.join(','));
  if (query.sort) p.set('sort', query.sort);
  if (query.limit !== undefined) p.set('limit', String(query.limit));
  if (query.offset !== undefined) p.set('offset', String(query.offset));
  return p.toString();
}

export const getCatalog = (query: CatalogQuery) => api<CatalogResponse>(`/api/works?${catalogQueryString(query)}`);
export const getCatalogCount = () => api<{ count: number }>('/api/works/count');
export const getWorkDetail = (id: string) => api<WorkDetail>(`/api/works/${id}`);

// --- public reader ---------------------------------------------------------------
export const getWork = (id: string) => api<ReaderWork>(`/api/reader/works/${id}`);
export const getToc = (id: string, limit: number, offset: number) =>
  api<TocResponse>(`/api/reader/works/${id}/chapters?limit=${limit}&offset=${offset}`);
export const getChapter = (id: string) => api<ReaderChapter>(`/api/reader/chapters/${id}`);

// --- member state ------------------------------------------------------------------
export const getLibrary = () => api<{ works: LibraryEntry[] }>('/api/me/library');
export const addToLibrary = (workId: string) => api<{ ok: true }>(`/api/me/library/${workId}`, json('PUT', {}));
export const removeFromLibrary = (workId: string) => api<{ ok: true }>(`/api/me/library/${workId}`, { method: 'DELETE' });
export const getFollows = () => api<{ follows: FollowEntry[] }>('/api/me/follows');
export const follow = (workId: string) => api<{ ok: true }>(`/api/me/follows/${workId}`, json('PUT', {}));
export const unfollow = (workId: string) => api<{ ok: true }>(`/api/me/follows/${workId}`, { method: 'DELETE' });
export const markFollowSeen = (workId: string) => api<{ ok: true }>(`/api/me/follows/${workId}/seen`, json('POST', {}));

export const getProgress = (workId: string) => api<{ progress: ServerProgress | null }>(`/api/me/progress/${workId}`);
export const saveProgress = (workId: string, body: {
  chapterId: string; revisionId: string; paragraphIndex: number; fraction?: number | null; baseVersion: number;
}) => api<{ ok: true; syncVersion: number }>(`/api/me/progress/${workId}`, json('PUT', body));

export const markRead = (chapterId: string) => api<{ ok: true }>('/api/me/reads', json('POST', { chapterId }));
export const getReads = (workId: string) => api<{ reads: Array<{ chapterId: string; lastReadAt: string }> }>(`/api/me/reads?workId=${workId}`);

export const getBookmarks = (workId?: string) =>
  api<{ bookmarks: BookmarkEntry[] }>(`/api/me/bookmarks${workId ? `?workId=${workId}` : ''}`);
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
