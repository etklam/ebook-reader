import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery, normalizeTaxonomyName, suggestTaxonomy } from './taxonomy-suggest.ts';
import type { TaxonomyItem } from '../api/types.ts';

const item = (id: string, displayName: string, extra: Partial<TaxonomyItem> = {}): TaxonomyItem =>
  ({ id, displayName, description: '', sortOrder: 0, isActive: true, ...extra });

const categories = [item('c1', '玄幻'), item('c2', '都市')];
const tags = [item('t1', '重生'), item('t2', 'Slice of Life')];

test('normalization ignores case, spacing and decorative punctuation', () => {
  assert.equal(normalizeTaxonomyName(' Slice-of_Life '), 'sliceoflife');
  assert.equal(normalizeTaxonomyName('【玄幻】'), '玄幻');
  assert.equal(normalizeTaxonomyName('   '), '');
});

test('keywords resolve to categories before tags, and unmatched ones default to tags', () => {
  assert.deepEqual(
    suggestTaxonomy(['玄幻', '重生', '機甲'], categories, tags)
      .map((s) => [s.keyword, s.match?.id ?? null, s.kind]),
    [['玄幻', 'c1', 'categories'], ['重生', 't1', 'tags'], ['機甲', null, 'tags']],
  );
});

test('suggestions dedupe keywords that normalize alike and skip empty ones', () => {
  const suggestions = suggestTaxonomy(['玄幻', '【玄幻】', '  ', 'slice of life'], categories, tags);
  assert.deepEqual(suggestions.map((s) => s.keyword), ['玄幻', 'slice of life']);
  assert.equal(suggestions[1].match?.id, 't2');
});

test('an inactive item still matches so the admin sees why it cannot be assigned', () => {
  const retired = [item('c9', '舊分類', { isActive: false })];
  const [suggestion] = suggestTaxonomy(['舊分類'], retired, []);
  assert.equal(suggestion.match?.id, 'c9');
  assert.equal(suggestion.match?.isActive, false);
});

test('search matches display name or description, and an empty query matches all', () => {
  assert.equal(matchesQuery(item('c1', '玄幻', { description: '東方奇幻' }), '奇幻'), true);
  assert.equal(matchesQuery(item('c1', '玄幻'), 'SLICE'), false);
  assert.equal(matchesQuery(item('c1', '玄幻'), '  '), true);
});
