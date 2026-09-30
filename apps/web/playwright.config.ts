// M5 browser acceptance (READ-01/READ-02 automated layer, §21.3).
// Playwright WebKit/headless Chromium ≠ real-device Safari/Chrome — L3 stays a
// manual gate (docs/adr/l3-device-checklist.md).
//
// Prereqs (local stack): pnpm db:up && pnpm db:migrate && pnpm dev:api &&
// pnpm dev:worker, then: pnpm --filter web test:browser
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,             // shared seeded works; serial execution
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 390, height: 844 }, // iPhone-class priority viewport
  },
});
