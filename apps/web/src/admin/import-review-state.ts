export interface ReviewRow {
  kind: 'source' | 'missing'; itemId?: string; chapterId?: string; labelRaw: string;
  matchedLabel?: string; afterLabel?: string; beforeLabel?: string;
  itemClass: string; matchedChapterId?: string | null; insertAfterChapterId?: string | null;
  insertBeforeChapterId?: string | null; positionConfident?: boolean; reason?: string[];
}
export function needsDecision(row: ReviewRow): boolean {
  return row.kind === 'source' && (['ambiguous', 'structural_conflict'].includes(row.itemClass) || (row.itemClass === 'new' && !row.positionConfident));
}
/** Keep the operation identity across network retries; changing the reviewed plan creates a new operation. */
export function applyIdentity(previous: { payload: string; key: string } | null, payload: string, newKey: () => string) {
  return previous?.payload === payload ? previous : { payload, key: newKey() };
}
export function reviewText(text: string) {
  return text.replace(/\[\[img:([0-9a-f]{64})(?:\|[\s\S]*?)?\]\]/gi, (_, hash: string) => `〔圖片 ${hash.slice(0, 12)}〕`);
}

const reasons: Record<string, string> = {
  label_key_unique: '原章號可唯一對應',
  duplicate_label_key: '來源或站方有重複章號，需人工確認',
  body_match_label_differs: '正文相同但章號不同，需確認章節身分',
  body_hash_equal: '正文與資源相同',
  body_hash_differs: '正文有差異',
  resources_changed: '圖片或資源說明有變更',
  body_belongs_to_other_chapter: '來源正文與另一個站方章節相同',
  match_order_inconsistent: '對應章節的順序與站方順序不同',
  span_count_mismatch: '前後對應章節之間的結構不一致',
  anchored_between_neighbors: '可依前後章節定位',
  tail_append_anchored: '可接續在已對應的最後章節之後',
  anchored_after: '可依前章定位',
  anchored_before: '可依後章定位',
  tail_over_existing_unmatched: '來源末尾之後仍有未對應的站方章節',
  no_anchors: '找不到可確認插入位置的章節錨點',
};
export function reviewReason(code: string): string {
  return reasons[code] ?? '需人工核對章節身分與來源順序';
}
