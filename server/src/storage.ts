// Private storage adapter (§16A-D): local volume now, S3-compatible later.
// Keys are server-generated only; callers can never pass a raw path.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const KEY_RE = /^[0-9a-f]{2}\/[0-9a-f-]+\.[a-z0-9]+$/;

export interface Storage {
  put(data: Buffer, ext: string): Promise<string>; // → storage key
  get(key: string): Promise<Buffer>;
  /** idempotent: deleting an already-missing object is success (GC is M7) */
  delete(key: string): Promise<void>;
}

// storage keys are `shard/uuid.ext`; shard derived from the uuid itself so
// directories stay narrow without trusting any caller input.
export function localStorage(root: string): Storage {
  return {
    async put(data, ext) {
      const id = randomUUID();
      const shard = id.slice(0, 2);
      const key = `${shard}/${id}.${ext.replace(/[^a-z0-9]/gi, '')}`;
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
      return key;
    },
    async get(key) {
      if (!KEY_RE.test(key)) throw new Error('invalid storage key');
      return readFile(join(root, key));
    },
    async delete(key) {
      if (!KEY_RE.test(key)) throw new Error('invalid storage key');
      await unlink(join(root, key)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    },
  };
}

// Run fn over items with a hard concurrency bound (stabilization §5): never
// start thousands of storage writes at once, no matter how long the input.
// Results keep input order. The first rejection wins; in-flight work settles.
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error('mapBounded: limit must be >= 1');
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Best-effort cleanup of objects created during a failed processing attempt.
// Failures here are logged-and-swallowed: storage orphans are GC'd in M7.
export async function deleteBestEffort(storage: Storage, keys: readonly string[]): Promise<void> {
  await Promise.allSettled(keys.map((k) => storage.delete(k)));
}
