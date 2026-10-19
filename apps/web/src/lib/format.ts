// Shared display vocabulary. These labels were duplicated across four screens;
// one source keeps 連載中 meaning the same thing everywhere.
//
// They are functions, not constants: a constant is evaluated once at import and
// would freeze the language the app happened to start in, so a locale switch
// would leave these labels behind while the rest of the page changed.
import type { SerialStatus, WorkType } from '../api/types.ts';
import { LOCALE_TAG } from '../i18n/locale.ts';
import { currentLocale, t } from '../i18n/translate.ts';

const TYPE_LABEL: Record<WorkType, string> = {
  serial: '連載',
  short_story: '短篇',
};

const TYPE_LABEL_LONG: Record<WorkType, string> = {
  serial: '長篇連載',
  short_story: '短篇小說',
};

const STATUS_LABEL: Record<Exclude<SerialStatus, null>, string> = {
  ongoing: '連載中',
  completed: '已完結',
  paused: '暫停',
};

export const typeLabel = (type: WorkType): string => t(TYPE_LABEL[type]);
export const typeLabelLong = (type: WorkType): string => t(TYPE_LABEL_LONG[type]);
export const statusLabel = (status: Exclude<SerialStatus, null>): string => t(STATUS_LABEL[status]);

const DAY = 86_400_000;

/** The tag `toLocaleString` should format in — follows the UI, not the OS, so
 *  a date never renders in a different language from the sentence around it. */
const tag = () => LOCALE_TAG[currentLocale()];

/** Calendar-day relative date; falls back to an absolute date past a week. */
export function relativeDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(then)) / DAY);
  if (days <= 0) return t('今天');
  if (days === 1) return t('昨天');
  if (days < 7) return t('{n} 天前', { n: days });
  return then.toLocaleDateString(tag(), { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(tag(), {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** 1284 → "1,284" with tabular figures handled in CSS. */
export function count(n: number): string {
  return n.toLocaleString(tag());
}
