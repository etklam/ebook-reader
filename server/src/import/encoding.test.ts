import { test } from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { decodeTxt, EncodingError } from './encoding.ts';

// sample with clear script evidence for the ambiguous Big5/GB18030 case
const TRAD = '他們來到這裡，說起從前的往事。這條路他走過無數次，後來門關上了。'.repeat(10);
const SIMP = '他们来到这里，说起从前的往事。这条路他走过无数次，后来门关上了。'.repeat(10);

test('UTF-8 without BOM', () => {
  const r = decodeTxt(Buffer.from(TRAD, 'utf8'));
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.confidence, 'high');
  assert.equal(r.text, TRAD);
});

test('UTF-8 with BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一章', 'utf8')]);
  const r = decodeTxt(buf);
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.confidence, 'bom');
  assert.ok(!r.text.startsWith('﻿'));
});

test('UTF-16 LE / BE with BOM', () => {
  const le = decodeTxt(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(TRAD, 'utf-16le')]));
  assert.equal(le.encoding, 'utf-16le');
  assert.equal(le.confidence, 'bom');
  const be = decodeTxt(Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(TRAD, 'utf-16be')]));
  assert.equal(be.encoding, 'utf-16be');
  assert.equal(be.text, TRAD);
});

test('Big5 detected via Traditional script evidence', () => {
  const r = decodeTxt(iconv.encode(TRAD, 'big5'));
  assert.equal(r.encoding, 'big5');
  assert.equal(r.text, TRAD);
});

test('GB18030 detected via Simplified script evidence', () => {
  const r = decodeTxt(iconv.encode(SIMP, 'gb18030'));
  assert.equal(r.encoding, 'gb18030');
  assert.equal(r.text, SIMP);
});

test('invalid UTF-8 (mojibake source) never passes as UTF-8', () => {
  // Big5 bytes are usually invalid strict UTF-8
  const buf = iconv.encode(TRAD, 'big5');
  const r = decodeTxt(buf);
  assert.notEqual(r.encoding, 'utf-8');
});

test('undecodable bytes raise ENCODING_UNDETERMINED instead of importing garbage', () => {
  // random bytes: invalid in every supported encoding
  const buf = Buffer.from([0x81, 0xff, 0xfe, 0x00, 0xd8, 0x00, 0x81, 0x41, 0x00, 0xd9, 0x99]);
  assert.throws(() => decodeTxt(buf), EncodingError);
});

test('admin override decodes strictly', () => {
  const buf = iconv.encode(TRAD, 'big5');
  const r = decodeTxt(buf, 'big5');
  assert.equal(r.confidence, 'high');
  assert.equal(r.text, TRAD);
  assert.throws(() => decodeTxt(buf, 'utf-8'), EncodingError);
  assert.throws(() => decodeTxt(buf, 'latin1'), EncodingError);
});
