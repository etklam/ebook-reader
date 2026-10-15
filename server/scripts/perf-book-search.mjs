// Real chapter objects + HTTP handlers; metadata is stubbed to isolate body I/O.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localStorage } from '../src/storage.ts';
import { works } from '../src/db/schema.ts';
import { searchExportRoutes } from '../src/routes/search-export.ts';

const output = process.argv[2];
if (!output) throw new Error('usage: node scripts/perf-book-search.mjs /tmp/search-before.json');
const root = await mkdtemp(join(tmpdir(), 'ebook-search-bench-'));
const storage = localStorage(root);
const workId = '00000000-0000-0000-0000-000000000001';
const work = { id: workId, visibility: 'public', activeReleaseId: '00000000-0000-0000-0000-000000000002', editVersion: 0 };
try {
  const rows = [];
  let corpusBytes = 0;
  for (let i = 0; i < 500; i++) {
    const body = Buffer.from(`第${i}章\n\n小龍出現。\n\n${('山川風雨，遠行之人繼續向前。'.repeat(40) + '\n\n').repeat(8)}`);
    corpusBytes += body.length;
    rows.push({ chapterId: `chapter-${i}`, revisionId: `revision-${i}`, labelRaw: `第${i}章`, title: '', contentKey: await storage.put(body, 'txt') });
  }
  const db = { select() {
    let selected = [];
    const chain = { from(table) { selected = table === works ? [work] : rows; return chain; },
      innerJoin() { return chain; }, where() { return chain; },
      limit() { return Promise.resolve(selected); }, orderBy() { return Promise.resolve(selected); } };
    return chain;
  } };
  const run = async (query) => {
    let reads = 0;
    let bytes = 0;
    const app = searchExportRoutes({ db, storage: { ...storage, async get(key) {
      const body = await storage.get(key); reads++; bytes += body.length; return body;
    } } });
    const start = performance.now();
    const response = await app.request(`/api/reader/works/${workId}/search?q=${encodeURIComponent(query)}`);
    if (response.status !== 200) throw new Error(`search failed: ${response.status} ${await response.text()}`);
    await response.arrayBuffer();
    return { ms: performance.now() - start, reads, bytes };
  };
  await run('小龍'); // converter/JIT warmup, not in reported samples
  const cases = [];
  for (const query of ['小龍', '未命中詞']) {
    for (const concurrency of [1, 4]) {
      const samples = [];
      for (let round = 0; round < 10; round++) samples.push(...await Promise.all(Array.from({ length: concurrency }, () => run(query))));
      const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
      cases.push({ query, concurrency, samples: samples.length,
        p50Ms: times[Math.floor(times.length * 0.5)], p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))],
        readsPerRequest: samples[0].reads, bytesPerRequest: samples[0].bytes });
    }
  }
  const result = { recordedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`,
    chapters: rows.length, corpusBytes, storage: 'real temporary local files, warm filesystem cache',
    metadata: 'stubbed; does not measure PostgreSQL, network, rate-limit throughput or production performance', cases };
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await rm(root, { recursive: true, force: true });
}
