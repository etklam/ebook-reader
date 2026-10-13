// Preloads live only in this reader instance and are consumed on navigation.
// A short TTL avoids carrying an old active release into a later visit.
export function createChapterLoader<T>(fetchChapter: (id: string) => Promise<T>, now = Date.now) {
  const preloads = new Map<string, { promise: Promise<T>; expires: number }>();
  function load(id: string): Promise<T> {
    const hit = preloads.get(id);
    preloads.delete(id);
    return hit && hit.expires > now() ? hit.promise : fetchChapter(id);
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
  return { load, prefetch };
}
