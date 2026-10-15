import { createHash } from 'node:crypto';

/** Analysis identity changes on every processing attempt, including identical source bytes. */
export function analysisVersion(job: { id: string; processorVersion: string; attemptCount: number; completedAt: Date | null }): string {
  return createHash('sha256').update(JSON.stringify([job.id, job.processorVersion, job.attemptCount, job.completedAt?.toISOString()])).digest('hex');
}
