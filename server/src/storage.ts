// Private storage adapter (§16A-D): local volume now, S3-compatible later.
// Keys are server-generated only; callers can never pass a raw path.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const ROOT = process.env.STORAGE_ROOT ?? './storage';

export interface Storage {
  put(data: Buffer, ext: string): Promise<string>; // → storage key
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

// storage keys are `shard/uuid.ext`; shard derived from the uuid itself so
// directories stay narrow without trusting any caller input.
export function localStorage(root = ROOT): Storage {
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
      if (!/^[0-9a-f]{2}\/[0-9a-f-]+\.[a-z0-9]+$/.test(key)) {
        throw new Error('invalid storage key');
      }
      return readFile(join(root, key));
    },
    async delete(key) {
      if (!/^[0-9a-f]{2}\/[0-9a-f-]+\.[a-z0-9]+$/.test(key)) {
        throw new Error('invalid storage key');
      }
      await unlink(join(root, key));
    },
  };
}
