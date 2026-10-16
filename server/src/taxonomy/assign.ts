// Shared work→taxonomy assignment (§03A/§50). One validation path for both the
// standalone PUT route and first-import commit, so a draft can be born already
// classified instead of failing the publish check later.
import { eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { categories, tags, workCategories, workTags } from '../db/schema.ts';

// configurable assignment limits (dev-plan §03A: ~5 categories / ~20 tags)
export const MAX_CATEGORIES_PER_WORK = 5;
export const MAX_TAGS_PER_WORK = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TaxonomyProblem { error: 'invalid_taxonomy'; detail: string }

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

// Shape/limit checks that need no database round trip.
export function validateTaxonomyIds(categoryIds: unknown, tagIds: unknown):
  { categoryIds: string[]; tagIds: string[] } | TaxonomyProblem {
  const cats = Array.isArray(categoryIds) ? categoryIds : [];
  const tgs = Array.isArray(tagIds) ? tagIds : [];
  const wellFormed = (ids: unknown[]): ids is string[] =>
    ids.every((id) => typeof id === 'string' && UUID_RE.test(id));
  if (!wellFormed(cats) || !wellFormed(tgs)) return { error: 'invalid_taxonomy', detail: 'id 格式錯誤' };
  if (new Set(cats).size !== cats.length || new Set(tgs).size !== tgs.length) {
    return { error: 'invalid_taxonomy', detail: 'id 重複' };
  }
  if (cats.length > MAX_CATEGORIES_PER_WORK) {
    return { error: 'invalid_taxonomy', detail: `分類上限 ${MAX_CATEGORIES_PER_WORK}` };
  }
  if (tgs.length > MAX_TAGS_PER_WORK) {
    return { error: 'invalid_taxonomy', detail: `標籤上限 ${MAX_TAGS_PER_WORK}` };
  }
  return { categoryIds: cats, tagIds: tgs };
}

// Replace-set assignment inside a caller-owned transaction. Policy: inactive
// taxonomy cannot be NEWLY assigned, but rows already on the work stay even if
// later deactivated — public works never silently lose metadata.
export async function assignWorkTaxonomy(
  tx: Tx,
  workId: string,
  categoryIds: string[],
  tagIds: string[],
): Promise<TaxonomyProblem | null> {
  const currentCats = (await tx.select({ id: workCategories.categoryId })
    .from(workCategories).where(eq(workCategories.workId, workId))).map((r) => r.id);
  const currentTags = (await tx.select({ id: workTags.tagId })
    .from(workTags).where(eq(workTags.workId, workId))).map((r) => r.id);

  for (const [table, ids, current] of [
    [categories, categoryIds, currentCats],
    [tags, tagIds, currentTags],
  ] as const) {
    const newIds = ids.filter((id) => !current.includes(id));
    if (newIds.length === 0) continue;
    const rows = await tx.select({ id: table.id, isActive: table.isActive })
      .from(table).where(inArray(table.id, newIds));
    if (rows.length !== new Set(newIds).size) {
      return { error: 'invalid_taxonomy', detail: '包含不存在的項目' };
    }
    if (rows.some((r) => !r.isActive)) {
      return { error: 'invalid_taxonomy', detail: '停用中的項目不能新指派' };
    }
  }

  await tx.delete(workCategories).where(eq(workCategories.workId, workId));
  await tx.delete(workTags).where(eq(workTags.workId, workId));
  if (categoryIds.length > 0) {
    await tx.insert(workCategories).values(categoryIds.map((categoryId) => ({ workId, categoryId })));
  }
  if (tagIds.length > 0) {
    await tx.insert(workTags).values(tagIds.map((tagId) => ({ workId, tagId })));
  }
  return null;
}
