// Shared display vocabulary. These labels were duplicated across four screens;
// one source keeps 連載中 meaning the same thing everywhere.
import type { SerialStatus, WorkType } from '../api/types.ts';

export const TYPE_LABEL: Record<WorkType, string> = {
  serial: '連載',
  short_story: '短篇',
};

export const TYPE_LABEL_LONG: Record<WorkType, string> = {
  serial: '長篇連載',
  short_story: '短篇小說',
};

export const STATUS_LABEL: Record<Exclude<SerialStatus, null>, string> = {
  ongoing: '連載中',
  completed: '已完結',
  paused: '暫停',
};

const DAY = 86_400_000;

/** Calendar-day relative date; falls back to an absolute date past a week. */
export function relativeDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(then)) / DAY);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return then.toLocaleDateString('zh-Hant', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-Hant', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** 1284 → "1,284" with tabular figures handled in CSS. */
export function count(n: number): string {
  return n.toLocaleString('zh-Hant');
}
