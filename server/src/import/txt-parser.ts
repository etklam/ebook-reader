// TXT chapter splitting (dev-plan §07). Deterministic, explainable heuristics:
// a heading must sit on its own short line, be preceded by a blank line (or
// file start), and carry no sentence-ending punctuation. Prose mentioning
// 「第十二章」 mid-paragraph never matches (anchor + blank-line + length).
// Text is never discarded: leading content becomes a review-flagged item, and
// a file with no headings at all becomes one whole-document item.
import { parseLabel, type ParsedLabel } from './parse-label.ts';

export interface StagedChapter {
  position: number;
  volumeLabel: string | null;
  labelRaw: string; // preserved exactly; '' when the source had no label
  parsed: ParsedLabel | null;
  title: string;
  body: string; // EOL-normalized paragraphs joined with \n\n
  warnings: string[];
  needsReview: boolean;
}

export interface ParsedTxt {
  chapters: StagedChapter[];
  warnings: string[]; // document-level warnings
}

// label portion of a heading line: marker + number + optional （上） sub-part
const HEADING_RE = new RegExp(
  '^(第[0-9０-９.．]+[章回節节]' + // 第12.5章 / 第012章
  '|第[零一二兩三四五六七八九十百千]+[章回節节]' + // 第十二章
  '|序章|序幕|楔子|引子' + // front matter
  '|終章|尾聲|後記|大結局' + // end matter
  '|番外[0-9０-９.．]*|外傳[0-9０-９.．]*|附錄[0-9０-９.．]*)' + // extras w/ optional number
  '(\\s*[（(][^（）()]{1,12}[）)])?' + // （上）/（下） sub-part
  '\\s*(.*)$',
);

const VOLUME_RE = /^\s*(第[0-9０-９零一二兩三四五六七八九十百千]+[卷集部][^\n]{0,20})\s*$/;
const SENTENCE_END = /[。！？…；：，、]$/;
const MAX_HEADING_LEN = 60;

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

// a short standalone line with no marker at all (e.g. 「風起」) is only
// trusted when the document already shows a consistent heading pattern —
// the caller enables this after the first marker heading is seen
function looksLikeBareTitle(line: string): boolean {
  const s = line.trim();
  return s.length > 0 && s.length <= 30 && !SENTENCE_END.test(s) && !/[.!?,;:]$/.test(s);
}

export function parseTxt(rawText: string): ParsedTxt {
  const warnings: string[] = [];
  const text = rawText.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const chapters: { volumeLabel: string | null; label: string; title: string; paraLines: string[]; marker: boolean }[] = [];
  let current: (typeof chapters)[number] = { volumeLabel: null, label: '', title: '', paraLines: [], marker: false };
  let volumeLabel: string | null = null;
  let sawMarkerHeading = false;
  let prevBlank = true; // file start counts as blank for the first heading

  for (const rawLine of lines) {
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

    const marker = looksLikeMarkerHeading(trimmed);
    if (marker && prevBlank) {
      sawMarkerHeading = true;
      if (current.paraLines.length > 0 || current.label || current.marker) chapters.push(current);
      current = { volumeLabel, label: marker.label, title: marker.title, paraLines: [], marker: true };
      prevBlank = false;
      continue;
    }

    if (sawMarkerHeading && prevBlank && !marker && looksLikeBareTitle(trimmed)) {
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
    return { chapters: [], warnings: ['empty_source'] };
  }

  // no marker heading and only one bare candidate → treat whole file as one
  // section rather than guessing a boundary (never lose content)
  if (!sawMarkerHeading) {
    if (chapters.length === 1 && chapters[0].label !== '' && chapters[0].paraLines.length === 0) {
      // single bare line with nothing after it — degenerate; keep as content
      return {
        chapters: [{ position: 0, volumeLabel: null, labelRaw: '', parsed: null, title: '', body: chapters[0].label, warnings: ['no_headings'], needsReview: true }],
        warnings: ['no_reliable_chapter_boundaries'],
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
  return { chapters: staged, warnings };
}
