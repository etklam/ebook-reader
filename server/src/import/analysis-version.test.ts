import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisVersion } from './analysis-version.ts';

test('analysis identity distinguishes reruns, processor versions and processing state', () => {
  const job = { id: 'job', processorVersion: 'v1', attemptCount: 1, completedAt: new Date('2026-10-15T00:00:00Z') };
  assert.equal(analysisVersion(job), analysisVersion({ ...job }));
  for (const patch of [{ attemptCount: 2 }, { processorVersion: 'v2' }, { completedAt: null }]) assert.notEqual(analysisVersion(job), analysisVersion({ ...job, ...patch }));
});
