// M0-4: OpenCC conversion sanity check (dev-plan §15).
// Verifies the pinned opencc-js version converts t<->cn and that we always
// derive from the original text, never round-trip simp->trad->simp.
// Run: node poc/opencc-poc.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Converter } from 'opencc-js';

const t2cn = Converter({ from: 't', to: 'cn' });
const cn2t = Converter({ from: 'cn', to: 't' });

const original = '記憶裡的聲音比畫面先回來，頭髮在風中顯得乾燥。他幹完了活，只出了一身汗。';

const simp = t2cn(original);
const trad = cn2t(original); // source is already traditional: expect identity

console.log('original :', original);
console.log('簡體     :', simp);
console.log('繁體(from original):', trad);

// simplified differs and contains known conversions
assert.notEqual(simp, original);
assert.ok(simp.includes('记忆') && simp.includes('头发'), 'expected simplified conversions missing');

// traditional-from-original is stable (no round-trip rewriting)
assert.equal(trad, original);

// ambiguous phrase 乾/幹/干: converter must make a deterministic choice,
// and our pipeline never uses it to rebuild the original (§15: 原文隨時可切換)
const amb = t2cn('乾燥的幹部');
console.log('歧義詞   :', amb);

const pkg = JSON.parse(await readFile(new URL('../node_modules/opencc-js/package.json', import.meta.url), 'utf8'));
console.log(`\nopencc-js version: ${pkg.version}（鎖定於 package.json）`);

console.log('\nopencc POC checks passed');
