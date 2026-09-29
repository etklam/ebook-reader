// Irregular chapter-label parsing (dev-plan §09).
// Canonical copy for M2+ — mirrors m0/label-parser/parse-label.ts (M0 POC
// archive stays untouched; fix both if the number rules ever change).
//
// Contract:
// - label_raw is the identity for display; this parser only produces
//   candidate-matching tokens. It must NEVER collapse 12.10 into 12.1 or
//   12.5 into 12.50 (no numeric coercion).
// - Normalization (leading zeros, full-width digits, Chinese numerals) is
//   for candidate generation only and never rewrites the raw label.
// - Unparseable numbering yields numbered: null — the chapter is still
//   accepted, matching just falls back to title/body evidence.

export type LabelKind = 'numbered' | 'front' | 'end' | 'extra' | 'unnumbered';

export interface ParsedLabel {
  raw: string;
  kind: LabelKind;
  /** dot-separated numeric parts as strings, e.g. ['12','5','1']; null if not recognized */
  parts: string[] | null;
  /** sub-part marker like 上/下 when present */
  subPart: string | null;
  /** candidate-matching key; two labels are numeric-candidate-equal iff key matches */
  key: string | null;
}

const FRONT = ['序章', '序幕', '楔子', '前言', '引子'];
const END = ['終章', '尾聲', '後記', '終曲', '大結局'];
const EXTRA = ['番外', '外傳', '附錄'];

// Full-width -> half-width digits
function normalizeDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// Chinese numeral -> arabic string (handles up to 千; enough for chapter labels)
const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function chineseNumeralToArabic(s: string): number | null {
  if (!s) return null;
  if (/^[零一二兩三四五六七八九]$/.test(s)) return CN_DIGIT[s];
  // positional forms: 十, 十二, 二十, 二十三, 一百二十三, 二千零五
  let total = 0, section = 0, digit: number | null = null;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      digit = CN_DIGIT[ch];
    } else if (ch === '十') {
      section += (digit ?? 1) * 10;
      digit = null;
    } else if (ch === '百') {
      section += (digit ?? 1) * 100;
      digit = null;
    } else if (ch === '千') {
      section += (digit ?? 1) * 1000;
      digit = null;
    } else {
      return null; // not a numeral we understand
    }
    if (digit !== null && digit !== 0) {
      // pending unit; wait for 十/百/千 or end
    }
  }
  total = section + (digit ?? 0);
  // sanity: rebuildable length check to reject things like 一二 (should be 十二 style)
  return total > 0 ? total : null;
}

// Strip leading zeros within each numeric part, keep trailing zeros (12.10 stays 12.10)
function normalizePart(p: string): string {
  const stripped = p.replace(/^0+(?=\d)/, '');
  return stripped;
}

function buildKey(parts: string[], subPart: string | null, prefix: string): string {
  return prefix + ':' + parts.map(normalizePart).join('.') + (subPart ? `#${subPart}` : '');
}

export function parseLabel(raw: string): ParsedLabel {
  const base: ParsedLabel = { raw, kind: 'unnumbered', parts: null, subPart: null, key: null };
  const s = normalizeDigits(raw.trim());

  // sub-part suffix: （上）（下）(上)(中)
  let subPart: string | null = null;
  const subMatch = s.match(/[（(]\s*([上下中])\s*[)）]\s*$/);
  let body = s;
  if (subMatch) {
    subPart = subMatch[1];
    body = s.slice(0, subMatch.index).trim();
  }

  const bare = body.replace(/\s+/g, '');

  // bare special labels (序章 / 終章 / 番外 without number)
  if (FRONT.includes(bare)) return { ...base, kind: 'front' };
  if (END.includes(bare)) return { ...base, kind: 'end' };

  // extra with optional number: 番外1.5 / 番外三
  for (const p of EXTRA) {
    if (bare.startsWith(p)) {
      const rest = bare.slice(p.length);
      const parts = parseNumericParts(rest);
      if (parts) return { raw, kind: 'extra', parts, subPart, key: buildKey(parts, subPart, 'extra') };
      return { ...base, kind: 'extra' };
    }
  }

  // 第N章 family: 第12.5.1章, 第012章, 第十二章, 第1章 潛在標題, or bare "12.5"
  let numSrc: string | null = null;
  const withMarker = bare.match(/^第(.+?)(?:章|回|節|节)(?:.+)?$/);
  if (withMarker) {
    numSrc = withMarker[1];
  } else if (/^[\d.]+$/.test(bare)) {
    numSrc = bare; // bare number label
  }

  if (numSrc !== null) {
    const parts = parseNumericParts(numSrc);
    if (parts) return { raw, kind: 'numbered', parts, subPart, key: buildKey(parts, subPart, 'ch') };
  }

  return { ...base }; // unnumbered title like 風起
}

// "12.5.1" | "012" | "十二" | "一百二十三" -> string parts, or null
function parseNumericParts(src: string): string[] | null {
  const s = normalizeDigits(src.trim());
  if (/^\d+(?:\.\d+)*$/.test(s) && s.length > 0 && !s.startsWith('.') && !s.endsWith('.')) {
    return s.split('.');
  }
  if (/^[零一二兩三四五六七八九十百千]+$/.test(s)) {
    const n = chineseNumeralToArabic(s);
    if (n !== null) return [String(n)];
  }
  return null;
}

// Part-wise numeric ordering for candidate ranking (NOT identity).
// 12.5 < 12.10 because part 2: 5 < 10 numerically; identity still differs.
export function compareLabels(a: ParsedLabel, b: ParsedLabel): number {
  if (a.parts && b.parts) {
    const len = Math.max(a.parts.length, b.parts.length);
    for (let i = 0; i < len; i++) {
      const pa = a.parts[i] !== undefined ? parseInt(normalizePart(a.parts[i]), 10) : -1;
      const pb = b.parts[i] !== undefined ? parseInt(normalizePart(b.parts[i]), 10) : -1;
      if (pa !== pb) return pa < pb ? -1 : 1;
    }
    const sa = a.subPart ?? '';
    const sb = b.subPart ?? '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return 0;
  }
  const rank = (p: ParsedLabel) => (p.kind === 'front' ? -1 : p.kind === 'end' || p.kind === 'extra' ? 2 : p.kind === 'unnumbered' ? 3 : 1);
  return rank(a) - rank(b);
}

// Candidate equality: same normalized numeric key (leading zeros / width / Chinese
// numerals collapse; trailing zeros and dot-count do NOT).
export function sameNumberCandidate(a: ParsedLabel, b: ParsedLabel): boolean {
  return a.key !== null && a.key === b.key;
}
