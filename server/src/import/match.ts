// Chapter matching (dev-plan §10, §11). Pure logic, no DB — the caller loads
// existing chapters and staged items. Conservative by design: uniqueness and
// adjacency evidence auto-match; anything else surfaces as ambiguous or
// structural_conflict for the Admin, never a silent overwrite. Reason codes
// are engineering evidence (ADR-05), not calibrated probabilities.
import { parseLabel, sameNumberCandidate } from './parse-label.ts';

export interface ExistingChapter {
  id: string;
  labelRaw: string;
  editorialPosition: number;
  /** null when the chapter has no revision yet */
  bodyCompareHash: string | null;
  title: string;
}

export interface SourceItemRef {
  itemId: string;
  position: number;
  labelRaw: string;
  volumeLabel: string | null;
  bodyHash: string;
  title: string;
}

export type ItemClass =
  | 'unchanged'      // matched, identical body
  | 'modified'       // matched, body differs — incremental keeps site version
  | 'new'            // no candidate; anchored insertion position known
  | 'ambiguous'      // multiple candidates or label/body disagreement → Admin
  | 'structural_conflict'; // split/merge/renumber evidence → Admin

export interface MatchResultItem {
  itemId: string;
  labelRaw: string;
  itemClass: ItemClass;
  matchedChapterId: string | null;
  /** for 'new': anchor evidence for the insertion position */
  insertAfterChapterId: string | null;
  insertBeforeChapterId: string | null;
  positionConfident: boolean;
  reason: string[];
}

export interface MatchResult {
  items: MatchResultItem[]; // source order
  missingFromSource: { chapterId: string; labelRaw: string; editorialPosition: number }[];
  needsReview: boolean;
  warnings: string[];
}

interface ParsedExisting {
  ch: ExistingChapter;
  key: string | null;
}

export function matchChapters(existing: ExistingChapter[], source: SourceItemRef[]): MatchResult {
  const warnings: string[] = [];

  // --- index existing by normalized label key ----------------------------------
  const parsedExisting: ParsedExisting[] = existing.map((ch) => ({
    ch,
    key: ch.labelRaw ? parseLabel(ch.labelRaw).key : null,
  }));
  const byKey = new Map<string, ParsedExisting[]>();
  for (const pe of parsedExisting) {
    if (pe.key === null) continue;
    const list = byKey.get(pe.key) ?? [];
    list.push(pe);
    byKey.set(pe.key, list);
  }
  const byBody = new Map<string, ParsedExisting[]>();
  for (const pe of parsedExisting) {
    if (!pe.ch.bodyCompareHash) continue;
    const list = byBody.get(pe.ch.bodyCompareHash) ?? [];
    list.push(pe);
    byBody.set(pe.ch.bodyCompareHash, list);
  }

  // --- pass 1: label-key matching ---------------------------------------------
  const claimedBy = new Map<string, string>(); // existing chapter id → source itemId
  const out: MatchResultItem[] = source.map((it) => ({
    itemId: it.itemId,
    labelRaw: it.labelRaw,
    itemClass: 'new',
    matchedChapterId: null,
    insertAfterChapterId: null,
    insertBeforeChapterId: null,
    positionConfident: false,
    reason: [],
  }));

  const keyed = source.filter((s) => s.labelRaw && parseLabel(s.labelRaw).key !== null);
  const keyUseCount = new Map<string, number>();
  for (const s of keyed) {
    const k = parseLabel(s.labelRaw).key!;
    keyUseCount.set(k, (keyUseCount.get(k) ?? 0) + 1);
  }

  for (const s of keyed) {
    const res = out.find((o) => o.itemId === s.itemId)!;
    const k = parseLabel(s.labelRaw).key!;
    const candidates = byKey.get(k) ?? [];
    if (candidates.length === 1 && keyUseCount.get(k) === 1 && !claimedBy.has(candidates[0].ch.id)) {
      // unique label key on both sides → matched candidate; verify body below
      res.matchedChapterId = candidates[0].ch.id;
      res.reason.push('label_key_unique');
      claimedBy.set(candidates[0].ch.id, s.itemId);
    } else if (candidates.length > 1 || keyUseCount.get(k)! > 1) {
      res.itemClass = 'ambiguous';
      res.reason.push('duplicate_label_key');
    }
    // candidates.length === 0 → stays 'new' for now
  }

  // --- pass 2: body-hash fallback for label-unmatched items -------------------
  for (const s of source) {
    const res = out.find((o) => o.itemId === s.itemId)!;
    if (res.matchedChapterId || res.itemClass !== 'new') continue;
    const hits = byBody.get(s.bodyHash) ?? [];
    const unclaimed = hits.filter((h) => !claimedBy.has(h.ch.id));
    if (unclaimed.length === 1) {
      // same body, different label: rename/renumber candidate — never auto
      res.itemClass = 'ambiguous';
      res.reason.push('body_match_label_differs');
    }
  }

  // --- pass 3: classify matched pairs; detect renumbering ---------------------
  for (const s of source) {
    const res = out.find((o) => o.itemId === s.itemId)!;
    if (!res.matchedChapterId) continue;
    const ex = existing.find((e) => e.id === res.matchedChapterId)!;
    if (ex.bodyCompareHash === s.bodyHash) {
      res.itemClass = 'unchanged';
      res.reason.push('body_hash_equal');
    } else {
      // body differs, but does it belong to a *different* existing chapter?
      const elsewhere = (byBody.get(s.bodyHash) ?? []).some((h) => h.ch.id !== ex.id);
      if (elsewhere) {
        res.itemClass = 'structural_conflict';
        res.reason.push('body_belongs_to_other_chapter');
      } else {
        res.itemClass = 'modified';
        res.reason.push('body_hash_differs');
      }
    }
  }

  // --- pass 4: order consistency + gap analysis for insert positions ----------
  const matchedSeq = out.filter((o) => o.matchedChapterId);
  let prevPos: number | null = null;
  for (const o of matchedSeq) {
    const ex = existing.find((e) => e.id === o.matchedChapterId)!;
    if (prevPos !== null && ex.editorialPosition < prevPos) {
      o.itemClass = 'structural_conflict';
      o.reason.push('match_order_inconsistent');
    }
    prevPos = ex.editorialPosition;
  }

  const matchedIds = new Set(matchedSeq.map((o) => o.matchedChapterId));
  const missing = existing
    .filter((e) => !matchedIds.has(e.id))
    .map((e) => ({ chapterId: e.id, labelRaw: e.labelRaw, editorialPosition: e.editorialPosition }));

  // walk gaps between consecutive matched anchors to place 'new' items
  const anchors = out
    .filter((o) => o.matchedChapterId)
    .map((o) => ({
      srcIdx: source.findIndex((s) => s.itemId === o.itemId),
      exPos: existing.find((e) => e.id === o.matchedChapterId)!.editorialPosition,
      chapterId: o.matchedChapterId!,
    }));

  const anyAnchor = anchors.length > 0;
  for (let i = 0; i < out.length; i++) {
    const res = out[i];
    if (res.itemClass !== 'new') continue;
    const prevAnchor = [...anchors].reverse().find((a) => a.srcIdx < i);
    const nextAnchor = anchors.find((a) => a.srcIdx > i);

    if (prevAnchor && nextAnchor) {
      res.insertAfterChapterId = prevAnchor.chapterId;
      res.insertBeforeChapterId = nextAnchor.chapterId;
      // span integrity: new items in this gap vs existing chapters between the
      // anchors that nobody matched — both non-zero means split/merge/renumber
      const betweenExisting = existing.filter(
        (e) => !matchedIds.has(e.id) && e.editorialPosition > prevAnchor.exPos && e.editorialPosition < nextAnchor.exPos,
      ).length;
      const newInGap = out.filter(
        (o, j) => o.itemClass === 'new' && j > prevAnchor.srcIdx && j < nextAnchor.srcIdx,
      ).length;
      if (betweenExisting > 0 && newInGap > 0) {
        res.itemClass = 'structural_conflict';
        res.reason.push('span_count_mismatch');
      } else {
        res.positionConfident = true;
        res.reason.push('anchored_between_neighbors');
      }
    } else if (prevAnchor) {
      // tail: anchored from the left — safe append unless the site still has
      // unmatched chapters beyond the anchor (leapfrog risk)
      const isLastSourceChunk = !nextAnchor; // no later anchor at all
      const missingAfter = existing.filter((e) => !matchedIds.has(e.id) && e.editorialPosition > prevAnchor.exPos).length;
      if (missingAfter > 0) {
        // source ends before chapters that exist on the site (e.g. only 1–170
        // uploaded against 1–180): appending here would leapfrog kept chapters
        res.itemClass = 'structural_conflict';
        res.reason.push('tail_over_existing_unmatched');
      } else {
        res.insertAfterChapterId = prevAnchor.chapterId;
        res.positionConfident = true;
        res.reason.push(isLastSourceChunk ? 'tail_append_anchored' : 'anchored_after');
      }
    } else if (nextAnchor) {
      res.insertBeforeChapterId = nextAnchor.chapterId;
      res.positionConfident = true;
      res.reason.push('anchored_before');
    } else {
      // no anchors at all → Admin must confirm placement (ADR-02: numeric
      // greater-than-max is never sufficient on its own)
      res.reason.push('no_anchors');
    }
  }
  if (!anyAnchor && out.length > 0) warnings.push('no_matched_anchors');

  const needsReview = out.some(
    (o) => o.itemClass === 'ambiguous' || o.itemClass === 'structural_conflict' || (o.itemClass === 'new' && !o.positionConfident),
  );
  return { items: out, missingFromSource: missing, needsReview, warnings };
}

// re-export for callers building previews
export { sameNumberCandidate };
