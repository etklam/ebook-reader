// Preloads live only in this reader instance and are consumed on navigation.
// A short TTL avoids carrying an old active release into a later visit.
export function createChapterLoader<T>(fetchChapter: (id: string) => Promise<T>, now = Date.now,
  validatePreload?: () => Promise<boolean>) {
  const preloads = new Map<string, { promise: Promise<T>; expires: number }>();
  function load(id: string): Promise<T> {
    const hit = preloads.get(id);
    preloads.delete(id);
    if (!hit || hit.expires <= now()) return fetchChapter(id);
    return validatePreload ? validatePreload().then((valid) => valid ? hit.promise : fetchChapter(id)) : hit.promise;
  }
  function prefetch(id: string | null): void {
    if (!id) return;
    const hit = preloads.get(id);
    if (hit && hit.expires > now()) return;
    preloads.delete(id);
    if (preloads.size >= 2) preloads.delete(preloads.keys().next().value!);
    const entry = { promise: fetchChapter(id), expires: now() + 30_000 };
    preloads.set(id, entry);
    void entry.promise.catch(() => { if (preloads.get(id) === entry) preloads.delete(id); });
  }
  return { load, prefetch, clear: () => preloads.clear() };
}

/** Trigger only near the end; a long chapter must not spend its TTL at entry. */
export function shouldPrefetchNext(mode: 'scroll' | 'paginated', position: {
  scrollTop: number; scrollHeight: number; viewportHeight: number; page: number; pageCount: number;
}): boolean {
  if (mode === 'paginated') return position.pageCount > 0 && position.page >= position.pageCount - 2;
  const span = position.scrollHeight - position.viewportHeight;
  return position.viewportHeight > 0 && (span <= position.viewportHeight * 0.2 || position.scrollTop >= span * 0.8);
}
