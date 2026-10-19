// Idempotent, bounded, local-volume backfill; canonical storage is unchanged.
// Run with the worker's STORAGE_ROOT. Existing objects also backfill on search.
import { localStorage } from '../src/storage.ts';
import { buildBodyIndex } from '../src/search/body-index.ts';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.env.STORAGE_ROOT;
if (!root) throw new Error('STORAGE_ROOT is required');
const storage = localStorage(root);
const remove = process.argv.includes('--remove');
let count = 0;
for (const key of await storage.list()) {
  if (!key.endsWith('.txt')) continue;
  const index = join(root, `${key}.sidx`);
  if (remove) await unlink(index).catch(error => { if (error.code !== 'ENOENT') throw error; });
  else await writeFile(index, buildBodyIndex((await storage.get(key)).toString('utf8')));
  count++;
}
console.log(`${remove ? 'Removed' : 'Built'} ${count} derived indexes; canonical objects unchanged`);
