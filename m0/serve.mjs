// Minimal static server for the M0 POC (serves the m0/ directory).
// ponytail: replace with a real static/prod server at M5+ if needed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.epub': 'application/epub+zip',
  '.xhtml': 'application/xhtml+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(8787, () => {
  console.log('epub.js   : http://localhost:8787/reader-poc/epubjs.html');
  console.log('foliate-js: http://localhost:8787/reader-poc/foliate.html');
});
