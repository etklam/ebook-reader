import { extractTxtMetadata, type ImportMetadata } from './metadata.ts';
// TXT chapter splitting (dev-plan §07). Deterministic, explainable heuristics:
// a heading must sit on its own short line and carry no sentence-ending
// punctuation. Prose mentioning 「第十二章」 mid-paragraph never matches (anchor + length).
// Text is never discarded: leading content becomes a review-flagged item, and
// a file with no headings at all becomes one whole-document item.
import { parseLabel, type ParsedLabel } from './parse-label.ts';
import type { ResourceRef } from './epub-parser.ts';

export interface StagedChapter {
  position: number;
  volumeLabel: string | null;
  labelRaw: string; // preserved exactly; '' when the source had no label
  parsed: ParsedLabel | null;
  title: string;
  body: string; // EOL-normalized paragraphs joined with \n\n
  warnings: string[];
  needsReview: boolean;
  /** resources this chapter's body references (ADR-08). TXT has none; EPUB
   *  fills it from extracted images. */
  resources?: ResourceRef[];
}

export interface ParsedTxt {
  metadata: ImportMetadata;
  chapters: StagedChapter[];
  warnings: string[]; // document-level warnings
}

// label portion of a heading line: marker + number + optional （上） sub-part.
// These forms are unambiguous on their own line, so one occurrence is enough.
const HEADING_RE = new RegExp(
  '^([第卷][0-9０-９.．一二三四五六七八九十零〇百千两兩]*[章回幕部節节集卷]' +
  '|序章|序幕|楔子|引子' + // front matter
  '|終章|终章|尾聲|尾声|後記|后记|終曲|终曲|大結局|大结局' + // end matter
  '|番外[0-9０-９.．]*|外[傳传][0-9０-９.．]*|附[錄录][0-9０-９.．]*)' + // extras w/ optional number
  '(\\s*[（(][^（）()]{1,12}[）)])?' + // （上）/（下） sub-part
  '\\s*(.*)$',
);

const NUM = '[0-9０-９零〇一二三四五六七八九十廿卅百千两兩]';

/** Bare-number heading forms (（二）, 【二】, 〔二〕, 二、, 其二).
 *
 *  Unlike the HEADING_RE forms these are ALSO ordinary prose: a lone
 *  （二）這是正文列舉 mid-chapter is an enumeration, not a chapter. So a single
 *  occurrence proves nothing — `weakHeadings` below only trusts a form the
 *  document uses as a consistent increasing sequence. That gate is what makes
 *  it safe to recognize the whole family instead of chasing one notation per
 *  bug report: a source numbering its chapters 【一】【二】【三】 used to parse
 *  as one book-length chapter, because nothing here matched and the bare-title
 *  fallback below is gated on having seen a marker heading first.
 *
 *  `requiresBlankBefore`: 一、 is far weaker than the bracketed forms — a
 *  sentence may genuinely open with 三、四月間的事 — so it additionally has to
 *  start a block. The bracketed forms do not, because many sources put a
 *  heading immediately after the previous paragraph with no blank line. */
const WEAK_FORMS: Array<{ re: RegExp; requiresBlankBefore: boolean }> = [
  { re: new RegExp(`^([（(]\\s*${NUM}+\\s*[）)])\\s*(.*)$`), requiresBlankBefore: false },
  { re: new RegExp(`^(【\\s*${NUM}+\\s*】)\\s*(.*)$`), requiresBlankBefore: false },
  { re: new RegExp(`^(〔\\s*${NUM}+\\s*〕)\\s*(.*)$`), requiresBlankBefore: false },
  { re: new RegExp(`^(其${NUM}+)\\s*(.*)$`), requiresBlankBefore: false },
  { re: new RegExp(`^(${NUM}+\\s*、)\\s*(.*)$`), requiresBlankBefore: true },
];

const VOLUME_RE = /^\s*((?:第|卷)[0-9０-９零〇一二兩两三四五六七八九十百千]+[卷集部][^\n]{0,20})\s*$/;
const SENTENCE_END = /[。！？…；：，、]$/;
const MAX_HEADING_LEN = 60;

export function validChapterPattern(source: string): boolean {
  if (!source || source.length > 200 || /\([^)]*[+*][^)]*\)[+*{]/.test(source)) return false;
  try {
    const pattern = new RegExp(source, 'i');
    return !pattern.test('');
  } catch { return false; }
}

function looksLikeMarkerHeading(line: string): { label: string; title: string } | null {
  if (line.length > MAX_HEADING_LEN) return null;
  const m = line.match(HEADING_RE);
  if (!m) return null;
  const label = (m[1] + (m[2] ?? '')).trim();
  const title = m[3].trim();
  // a title that ends a sentence means this is prose, not a heading
  if (SENTENCE_END.test(title)) return null;
  return { label, title };
}

/** Which lines a weak form claims, decided over the WHOLE document.
 *
 *  For each form: collect every line it matches, keep the longest run whose
 *  numbers strictly increase, and accept those lines only if at least two
 *  survive. Two is the smallest count that distinguishes "this document numbers
 *  its chapters this way" from "one line of prose happens to start with （二）".
 *  Numbers are read through parseLabel so 廿一, （１２） and (12) all compare as
 *  integers; a form whose number cannot be parsed is not a candidate at all. */
type WeakHeading = { label: string; title: string } | null;
function weakHeadings(lines: readonly string[]): Map<number, WeakHeading> {
  const accepted = new Map<number, { label: string; title: string }>();
  // Lines that look like a weak heading but lost the sequence check. They must
  // not fall through to looksLikeBareTitle either: having just decided this
  // line is an enumeration, the looser rule must not re-promote it.
  const rejected = new Set<number>();
  let blankBefore = true; // file start opens a block
  const blocks = lines.map((raw) => {
    const starts = blankBefore;
    blankBefore = raw.trim() === '';
    return starts;
  });
  for (const { re, requiresBlankBefore } of WEAK_FORMS) {
    const hits: Array<{ line: number; n: number; label: string; title: string }> = [];
    for (const [i, raw] of lines.entries()) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > MAX_HEADING_LEN) continue;
      if (requiresBlankBefore && !blocks[i]) continue;
      const m = trimmed.match(re);
      if (!m) continue;
      const title = m[2].trim();
      if (SENTENCE_END.test(title)) continue; // a sentence, not a heading
      const label = m[1].trim();
      const parts = parseLabel(label).parts;
      if (!parts) continue;
      hits.push({ line: i, n: Number(parts[0]), label, title });
    }
    const kept: typeof hits = [];
    for (const hit of hits) {
      if (!kept.length || hit.n > kept[kept.length - 1].n) kept.push(hit);
      else rejected.add(hit.line);
    }
    if (kept.length < 2) {
      for (const hit of hits) rejected.add(hit.line);
      continue;
    }
    for (const hit of kept) accepted.set(hit.line, { label: hit.label, title: hit.title });
  }
  const result = new Map<number, WeakHeading>();
  for (const line of rejected) result.set(line, null);
  for (const [line, heading] of accepted) result.set(line, heading); // accepted wins
  return result;
}

// a short standalone line with no marker at all (e.g. 「風起」) is only
// trusted when the document already shows a consistent heading pattern —
// the caller enables this after the first marker heading is seen
function looksLikeBareTitle(line: string): boolean {
  const s = line.trim();
  return s.length > 0 && s.length <= 30 && !SENTENCE_END.test(s) && !/[.!?,;:]$/.test(s);
}

export function parseTxt(rawText: string, options: { chapterPattern?: string } = {}): ParsedTxt {
  const warnings: string[] = [];
  const customHeading = options.chapterPattern ? new RegExp(options.chapterPattern, 'i') : null;
  const text = rawText.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const chapters: { volumeLabel: string | null; label: string; title: string; paraLines: string[]; marker: boolean }[] = [];
  let current: (typeof chapters)[number] = { volumeLabel: null, label: '', title: '', paraLines: [], marker: false };
  let volumeLabel: string | null = null;
  let sawMarkerHeading = false;
  let prevBlank = true; // file start counts as blank for the first heading
  // An explicit chapterPattern is the Admin telling us the rule; do not also
  // guess with the weak forms and risk splitting on something they excluded.
  const weak: Map<number, WeakHeading> = customHeading ? new Map() : weakHeadings(lines);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '') {
      prevBlank = true;
      continue;
    }

    const vol = trimmed.match(VOLUME_RE);
    if (vol && line.length <= 40) {
      volumeLabel = vol[1].trim();
      prevBlank = true;
      continue;
    }

    const marker = customHeading ? (() => {
      if (trimmed.length > MAX_HEADING_LEN) return null;
      const match = customHeading.exec(trimmed);
      if (!match || match.index !== 0 || !match[0]) return null;
      return { label: (match[1] ?? match[0]).trim(), title: (match[2] ?? trimmed.slice(match[0].length)).trim() };
    })() : (looksLikeMarkerHeading(trimmed) ?? weak.get(index) ?? null);
    if (marker) {
      sawMarkerHeading = true;
      if (current.paraLines.length > 0 || current.label || current.marker) chapters.push(current);
      current = { volumeLabel, label: marker.label, title: marker.title, paraLines: [], marker: true };
      prevBlank = false;
      continue;
    }

    if (sawMarkerHeading && prevBlank && !marker && !weak.has(index) && looksLikeBareTitle(trimmed)) {
      // bare title line: the whole line is the label
      if (current.paraLines.length > 0 || current.label || current.marker) chapters.push(current);
      current = { volumeLabel, label: trimmed, title: '', paraLines: [], marker: false };
      prevBlank = false;
      continue;
    }

    current.paraLines.push(trimmed);
    prevBlank = false;
  }
  if (current.paraLines.length > 0 || current.label || current.marker) chapters.push(current);

  if (chapters.length === 0) {
    return { chapters: [], warnings: ['empty_source'], metadata: {} };
  }

  // no marker heading and only one bare candidate → treat whole file as one
  // section rather than guessing a boundary (never lose content)
  if (!sawMarkerHeading) {
    if (chapters.length === 1 && chapters[0].label !== '' && chapters[0].paraLines.length === 0) {
      // single bare line with nothing after it — degenerate; keep as content
      return {
        chapters: [{ position: 0, volumeLabel: null, labelRaw: '', parsed: null, title: '', body: chapters[0].label, warnings: ['no_headings'], needsReview: true }],
        warnings: ['no_reliable_chapter_boundaries'],
        metadata: extractTxtMetadata(text),
      };
    }
    warnings.push('no_reliable_chapter_boundaries');
  }

  const labelCounts = new Map<string, number>();
  const staged: StagedChapter[] = chapters.map((ch, i) => {
    const body = ch.paraLines.join('\n\n');
    const chWarnings: string[] = [];
    let needsReview = false;

    if (ch.label === '') {
      chWarnings.push(i === 0 ? 'leading_content_before_first_heading' : 'unlabeled_section');
      needsReview = true;
    }
    if (body === '') chWarnings.push('empty_chapter');
    if (ch.title.length > 100) chWarnings.push('unusually_long_title');
    const count = (labelCounts.get(ch.label) ?? 0) + 1;
    labelCounts.set(ch.label, count);
    if (count === 2) chWarnings.push('duplicate_label');

    if (!sawMarkerHeading) needsReview = true;
    return {
      position: i,
      volumeLabel: ch.volumeLabel,
      labelRaw: ch.label,
      parsed: ch.label ? parseLabel(ch.label) : null,
      title: ch.title,
      body,
      warnings: chWarnings,
      needsReview,
    };
  });

  if (staged.length === 1 && sawMarkerHeading) warnings.push('single_heading');
  return { chapters: staged, warnings, metadata: extractTxtMetadata(text) };
}
