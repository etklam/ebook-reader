// Import job state machine (stabilization §3). Single source of truth for
// states and legal transitions; every mutation goes through assertTransition
// so illegal transitions fail explicitly instead of silently overwriting.
export const IMPORT_STATES = [
  'queued', 'processing', 'review_required', 'ready',
  'failed', 'cancelled', 'committed', 'applied', 'reverted',
] as const;

export type ImportStatus = (typeof IMPORT_STATES)[number];

export const TERMINAL_STATES: readonly ImportStatus[] = ['cancelled', 'committed', 'applied'];

// from → set of legal successor states:
// - upload inserts queued
// - claim: queued → processing (or reclaim of an expired processing lease)
// - worker success: processing → review_required | ready
// - worker infra error: processing → queued (retry) | failed (attempts gone)
// - parse/domain failure: processing → failed
// - reanalyze: ready | review_required | failed → queued
// - commit: ready | review_required → committed
// - incremental/overwrite apply: ready | review_required → applied
// - protected revert (M4): applied → reverted (only while the work is still
//   at the version that apply produced — later edits block it, VER-02)
// - committed / reverted are terminal: the canonical result is already durable
export const TRANSITIONS: Readonly<Record<ImportStatus, readonly ImportStatus[]>> = {
  queued: ['processing', 'cancelled'],
  processing: ['queued', 'review_required', 'ready', 'failed', 'cancelled'],
  review_required: ['ready', 'queued', 'cancelled'],
  ready: ['queued', 'committed', 'applied', 'cancelled'],
  failed: ['queued', 'cancelled'],
  cancelled: [],
  committed: [],
  applied: ['reverted'],
  reverted: [],
};

export function canTransition(from: string, to: string): boolean {
  const succ = TRANSITIONS[from as ImportStatus];
  return succ !== undefined && succ.includes(to as ImportStatus);
}

export class IllegalTransitionError extends Error {
  from: string;
  to: string;
  constructor(from: string, to: string) {
    super(`illegal import job transition: ${from} → ${to}`);
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: string, to: string): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
