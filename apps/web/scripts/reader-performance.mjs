// Reproducible DOM benchmark. Run against pnpm dev:web; output lives outside Git.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const output = process.argv[2];
if (!output) throw new Error('usage: node scripts/reader-performance.mjs /tmp/reader-before.json');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.tracing.start({ screenshots: false, snapshots: true });
  const page = await context.newPage();
  await page.goto('http://localhost:5173');
  const result = await page.evaluate(async () => {
    const { captureScrollIndex } = await import('/src/reader/position.ts');
    const results = [];
    for (const count of [100, 5000]) {
      document.body.innerHTML = '<div id="viewport" style="height:700px;width:350px;overflow:auto;font:18px/1.9 serif"><div id="body"></div></div>';
      const viewport = document.getElementById('viewport');
      const root = document.getElementById('body');
      root.innerHTML = Array.from({ length: count }, (_, i) => `<p data-paragraph-index="${i}">第${i}段。${'小說正文，慢慢閱讀。'.repeat(8)}</p>`).join('');
      let geometryReads = 0;
      const originalRect = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.hasAttribute('data-paragraph-index')) geometryReads++;
        return originalRect.call(this);
      };
      const elapsed = [];
      const frameIntervals = [];
      const longTasks = [];
      const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)));
      observer.observe({ type: 'longtask', buffered: false });
      let previousFrame = 0;
      try {
        for (let i = 0; i < 90; i++) {
          await new Promise((resolve) => requestAnimationFrame((time) => {
            if (previousFrame) frameIntervals.push(time - previousFrame);
            previousFrame = time;
            resolve();
          }));
          viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * (0.8 + (i % 20) / 100);
          // Settle layout identically before timing each lookup.
          viewport.getBoundingClientRect();
          const start = performance.now();
          captureScrollIndex(viewport, root);
          elapsed.push(performance.now() - start);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        HTMLElement.prototype.getBoundingClientRect = originalRect;
        observer.disconnect();
      }
      const percentile = (items, p) => [...items].sort((a, b) => a - b)[Math.min(items.length - 1, Math.floor(items.length * p))];
      results.push({ paragraphs: count, captures: elapsed.length, geometryReads,
        p50Ms: percentile(elapsed, 0.5), p95Ms: percentile(elapsed, 0.95),
        frameP95Ms: percentile(frameIntervals, 0.95), longTasksMs: longTasks });
    }
    return { userAgent: navigator.userAgent, viewport: '390x844', font: '18px/1.9 serif',
      mode: 'scroll', images: 0, scenario: '90 near-end position lookups, 80–99% of chapter, one per animation frame', results };
  });
  await context.tracing.stop({ path: `${output}.trace.zip` });
  await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), ...result }, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
