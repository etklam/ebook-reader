import { createHash } from 'node:crypto';

type QualityItem = { position: number; volumeLabel?: string | null; labelRaw: string; title: string; parsedLabel: unknown; bodyHash: string };
export interface QualityIssue { type: 'empty' | 'duplicate' | 'gap'; positions: number[]; labels: string[]; message: string }
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** Read-only checks: flags suspicious source positions without changing import data. */
export function inspectImport(items: QualityItem[]) {
  const issues: QualityIssue[] = [];
  const duplicates = new Map<string, QualityItem[]>();
  const bodies = new Map<string, QualityItem[]>();
  const numbered: Array<{ n: number; family: string; item: QualityItem }> = [];
  for (const item of items) {
    if (item.bodyHash === EMPTY_SHA256) issues.push({ type: 'empty', positions: [item.position], labels: [item.labelRaw], message: '章節內容為空' });
    const parsed = item.parsedLabel as { kind?: string; parts?: unknown; key?: string } | null;
    const key = parsed?.kind === 'numbered' && parsed.key ? `${item.volumeLabel ?? ''}|${parsed.key}` : '';
    if (key) {
      const matches = duplicates.get(key) ?? [];
      matches.push(item); duplicates.set(key, matches);
    }
    if (item.bodyHash !== EMPTY_SHA256) {
      const matches = bodies.get(item.bodyHash) ?? [];
      matches.push(item); bodies.set(item.bodyHash, matches);
    }
    if (parsed?.kind === 'numbered' && Array.isArray(parsed.parts) && parsed.parts.length === 1) {
      const n = Number(parsed.parts[0]);
      if (Number.isSafeInteger(n) && n > 0 && n <= 1_000_000) numbered.push({ n, family: parsed.key?.split(':')[0] ?? '', item });
    }
  }
  for (const matches of duplicates.values()) if (matches.length > 1) {
    issues.push({ type: 'duplicate', positions: matches.map((item) => item.position), labels: matches.map((item) => item.labelRaw), message: '章號重複' });
  }
  for (const matches of bodies.values()) if (matches.length > 1) {
    issues.push({ type: 'duplicate', positions: matches.map((item) => item.position), labels: matches.map((item) => item.labelRaw), message: '正文完全相同' });
  }
  numbered.sort((a, b) => a.item.position - b.item.position);
  for (let i = 1; i < numbered.length; i++) {
    const previous = numbered[i - 1], current = numbered[i];
    if (current.item.volumeLabel === previous.item.volumeLabel && current.family === previous.family && current.n > previous.n + 1) {
      issues.push({ type: 'gap', positions: [previous.item.position, current.item.position],
        labels: [previous.item.labelRaw, current.item.labelRaw], message: `章號由 ${previous.n} 跳至 ${current.n}` });
    }
  }
  return { total: items.length, issueCount: issues.length,
    counts: { empty: issues.filter((i) => i.type === 'empty').length,
      duplicates: issues.filter((i) => i.type === 'duplicate').length,
      gaps: issues.filter((i) => i.type === 'gap').length }, issues };
}
