import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Converter } from 'opencc-js/t2cn';
import { localeFromTags } from './locale.ts';
import { __setTranslationInternals, t } from './translate.ts';
import { applyVocabulary, ZH_HANS_VOCABULARY } from './vocabulary.ts';

const convert = Converter({ from: 't', to: 'cn' }) as (s: string) => string;

const hans = () => __setTranslationInternals('zh-Hans', convert);
const hant = () => __setTranslationInternals('zh-Hant', convert);

test('the default locale returns the source untouched', () => {
  hant();
  assert.equal(t('目錄'), '目錄');
  assert.equal(t('載入中'), '載入中');
});

test('Simplified goes through the vocabulary map, then opencc', () => {
  hans();
  assert.equal(t('目錄'), '目录');       // characters only
  assert.equal(t('載入中'), '加载中');    // 載入 → 加载 by vocabulary
  assert.equal(t('搜尋作品'), '搜索作品');
  assert.equal(t('登入'), '登录');
  assert.equal(t('收起工具列'), '收起工具栏'); // opencc alone leaves 工具列 as-is
  assert.equal(t('暱稱'), '昵称');          // opencc alone yields the non-word 暱称
});

test('every vocabulary replacement survives the opencc pass', () => {
  // The map substitutes Simplified text and then the whole string is converted
  // again; a replacement opencc rewrites would silently undo the override.
  for (const [source, replacement] of Object.entries(ZH_HANS_VOCABULARY)) {
    assert.equal(convert(replacement), replacement, `${source} → ${replacement} is not opencc-stable`);
    assert.equal(t(source), replacement);
  }
});

test('longer vocabulary entries win over shorter overlapping ones', () => {
  hans();
  assert.equal(applyVocabulary('空白鍵'), '空格键');
});

test('placeholders interpolate in both locales', () => {
  hant();
  assert.equal(t('共 {n} 章', { n: 12 }), '共 12 章');
  hans();
  assert.equal(t('已載入 {n} 章', { n: 3 }), '已加载 3 章');
});

test('an unknown placeholder is left visible rather than blanked', () => {
  hant();
  assert.equal(t('共 {n} 章', { other: 1 }), '共 {n} 章');
});

test('without a converter, Simplified degrades to the source', () => {
  __setTranslationInternals('zh-Hans', null);
  assert.equal(t('目錄'), '目錄');
  // and it must not have cached that fallback for when the converter arrives
  hans();
  assert.equal(t('目錄'), '目录');
});

test('browser tags only pick Simplified when they say so', () => {
  assert.equal(localeFromTags(['zh-Hans-CN', 'en']), 'zh-Hans');
  assert.equal(localeFromTags(['zh-CN']), 'zh-Hans');
  assert.equal(localeFromTags(['zh-SG']), 'zh-Hans');
  assert.equal(localeFromTags(['zh-TW']), 'zh-Hant');
  assert.equal(localeFromTags(['zh-HK']), 'zh-Hant');
  // a bare `zh` names no script: the content here is Traditional, so guessing
  // Simplified would be the more disruptive wrong answer
  assert.equal(localeFromTags(['zh']), 'zh-Hant');
  assert.equal(localeFromTags(['en-US', 'ja']), 'zh-Hant');
  assert.equal(localeFromTags([]), 'zh-Hant');
});
