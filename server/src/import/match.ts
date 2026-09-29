// Chapter matching (dev-plan §10, §11). Pure logic, no DB — the caller loads
// existing chapters and staged items. Conservative by design: uniqueness and
// adjacency evidence auto-match; anything else surfaces as ambiguous or
// structural_conflict for the Admin, never a silent overwrite. Reason codes
// are engineering evidence (ADR-05), not calibrated probabilities.
// Stabilization §10: all lookups are map/binary-search based — O(n log n)
// total for multi-thousand-chapter novels.
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

function pushTo<K>(map: Map<K, ParsedExisting[]>, key: K, val: ParsedExisting): void {
  const list = map.get(key);
  if (list) list.push(val);
  else map.set(key, [val]);
}

export function matchChapters(existing: ExistingChapter[], source: SourceItemRef[]): MatchResult {
  const warnings: string[] = [];

  // --- index existing by normalized label key / body hash ----------------------
  const parsedExisting: ParsedExisting[] = existing.map((ch) => ({
    ch,
    key: ch.labelRaw ? parseLabel(ch.labelRaw).key : null,
  }));
  const byKey = new Map<string, ParsedExisting[]>();
  const byBody = new Map<string, ParsedExisting[]>();
  for (const pe of parsedExisting) {
    if (pe.key !== null) pushTo(byKey, pe.key, pe);
    if (pe.ch.bodyCompareHash) pushTo(byBody, pe.ch.bodyCompareHash, pe);
  }
  const existingById = new Map(existing.map((e) => [e.id, e]));

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
  const outById = new Map(out.map((o) => [o.itemId, o]));

  // parse each source label exactly once, up front
  const srcKeys = source.map((s) => (s.labelRaw ? parseLabel(s.labelRaw).key : null));
  const keyUseCount = new Map<string, number>();
  for (const k of srcKeys) if (k !== null) keyUseCount.set(k, (keyUseCount.get(k) ?? 0) + 1);

  for (let i = 0; i < source.length; i++) {
    const k = srcKeys[i];
    if (k === null) continue;
    const res = out[i];
    const candidates = byKey.get(k) ?? [];
    const uniqueUse = keyUseCount.get(k) === 1;
    if (candidates.length === 1 && uniqueUse && !claimedBy.has(candidates[0].ch.id)) {
      // unique label key on both sides → matched candidate; verify body below
      res.matchedChapterId = candidates[0].ch.id;
      res.reason.push('label_key_unique');
      claimedBy.set(candidates[0].ch.id, source[i].itemId);
    } else if (candidates.length > 1 || !uniqueUse) {
      res.itemClass = 'ambiguous';
      res.reason.push('duplicate_label_key');
    }
    // candidates.length === 0 → stays 'new' for now
  }

  // --- pass 2: body-hash fallback for label-unmatched items -------------------
  for (const s of source) {
    const res = outById.get(s.itemId)!;
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
    const res = outById.get(s.itemId)!;
    if (!res.matchedChapterId) continue;
    const ex = existingById.get(res.matchedChapterId)!;
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
  let prevPos: number | null = null;
  for (const o of out) {
    if (!o.matchedChapterId) continue;
    const ex = existingById.get(o.matchedChapterId)!;
    if (prevPos !== null && ex.editorialPosition < prevPos) {
      o.itemClass = 'structural_conflict';
      o.reason.push('match_order_inconsistent');
    }
    prevPos = ex.editorialPosition;
  }

  const matchedIds = new Set<string>();
  for (const o of out) if (o.matchedChapterId) matchedIds.add(o.matchedChapterId);
  const missing = existing
    .filter((e) => !matchedIds.has(e.id))
    .map((e) => ({ chapterId: e.id, labelRaw: e.labelRaw, editorialPosition: e.editorialPosition }));

  // anchors are matched items in source order (out follows source order, so
  // srcIdx is simply the running index — no per-anchor findIndex)
  const anchors: { srcIdx: number; exPos: number; chapterId: string }[] = [];
  for (let i = 0; i < out.length; i++) {
    const mid = out[i].matchedChapterId;
    if (!mid) continue;
    anchors.push({
      srcIdx: i,
      exPos: existingById.get(mid)!.editorialPosition,
      chapterId: mid,
    });
  }

  // unmatched existing positions, sorted, with prefix counts — answers
  // "how many unmatched chapters lie in (a, b)" by binary search
  const unmatchedPos = existing
    .filter((e) => !matchedIds.has(e.id))
    .map((e) => e.editorialPosition)
    .sort((a, b) => a - b);
  // count of unmatched positions < x
  const countBelow = (x: number): number => {
    let lo = 0, hi = unmatchedPos.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (unmatchedPos[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  // per-gap counters of currently-'new' items: original semantics counted
  // `out.filter(itemClass==='new' && in gap)` at each step, and items flipped
  // to structural_conflict earlier in the same gap drop out of later counts —
  // replicate with a mutable per-gap counter
  const newInGap = new Map<string, number>();
  const gapKeyOf = new Array<string | null>(out.length).fill(null);
  let ai = 0;
  for (let i = 0; i < out.length; i++) {
    while (ai < anchors.length && anchors[ai].srcIdx < i) ai++;
    const prev = ai > 0 ? anchors[ai - 1] : undefined;
    const next = anchors[ai];
    if (out[i].itemClass === 'new' && prev && next) {
      const key = `${prev.srcIdx}:${next.srcIdx}`;
      gapKeyOf[i] = key;
      newInGap.set(key, (newInGap.get(key) ?? 0) + 1);
    }
  }

  const anyAnchor = anchors.length > 0;
  ai = 0;
  for (let i = 0; i < out.length; i++) {
    const res = out[i];
    while (ai < anchors.length && anchors[ai].srcIdx < i) ai++;
    const prevAnchor = ai > 0 ? anchors[ai - 1] : undefined;
    const nextAnchor = anchors[ai];
    if (res.itemClass !== 'new') continue;

    if (prevAnchor && nextAnchor) {
      res.insertAfterChapterId = prevAnchor.chapterId;
      res.insertBeforeChapterId = nextAnchor.chapterId;
      // span integrity: new items in this gap vs existing chapters between the
      // anchors that nobody matched — both non-zero means split/merge/renumber
      const betweenExisting = countBelow(nextAnchor.exPos) - countBelow(prevAnchor.exPos);
      const gapNew = newInGap.get(gapKeyOf[i]!) ?? 0;
      if (betweenExisting > 0 && gapNew > 0) {
        res.itemClass = 'structural_conflict';
        res.reason.push('span_count_mismatch');
        newInGap.set(gapKeyOf[i]!, gapNew - 1); // later items in this gap see the flip
      } else {
        res.positionConfident = true;
        res.reason.push('anchored_between_neighbors');
      }
    } else if (prevAnchor) {
      // tail: anchored from the left — safe append unless the site still has
      // unmatched chapters beyond the anchor (leapfrog risk)
      const isLastSourceChunk = !nextAnchor; // no later anchor at all
      const missingAfter = unmatchedPos.length - countBelow(prevAnchor.exPos);
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
