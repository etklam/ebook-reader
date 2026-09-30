// Shared API client: same-origin credentials, JSON parsing, typed errors.
export class ApiRequestError extends Error {
  constructor(public status: number, public code: string) {
    super(`api ${status}: ${code}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (body as { error?: string }).error ?? 'unknown_error';
    throw new ApiRequestError(res.status, code);
  }
  return body as T;
}

export const getWork = (id: string) => api<import('./types.ts').ReaderWork>(`/api/reader/works/${id}`);
export const getToc = (id: string, limit: number, offset: number) =>
  api<import('./types.ts').TocResponse>(`/api/reader/works/${id}/chapters?limit=${limit}&offset=${offset}`);
export const getChapter = (id: string) => api<import('./types.ts').ReaderChapter>(`/api/reader/chapters/${id}`);
export const getMe = () => api<{ user: import('./types.ts').Me | null }>('/api/me');
