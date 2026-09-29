// Encoding detection & decoding for TXT imports (dev-plan §07).
//
// Never silently imports mojibake: BOM is authoritative, strict UTF-8
// validation decides UTF-8, and Big5 vs GB18030 is separated by script
// frequency (Traditional-only vs Simplified-only chars). Anything ambiguous
// degrades to low confidence — the caller flags review_required instead of
// guessing. Decoding uses Node's full-ICU TextDecoder (fatal mode) so no
// invalid byte ever becomes an undetected replacement character.
export type SupportedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'big5' | 'gb18030';

export interface EncodingResult {
  encoding: SupportedEncoding;
  /** bom: explicit marker · high: strict validation · medium: single valid candidate · low: ambiguous guess */
  confidence: 'bom' | 'high' | 'medium' | 'low';
  reason: string;
  warnings: string[];
  text: string;
}

// chars that only occur in one script (shared chars like 的 are useless here)
const TRAD_ONLY = '這裡說對後們來時東車馬鳥龍鳳無發開關門問間書長張萬與億過還讓變應該點';
const SIMP_ONLY = '这里说对后们来时东车马鸟龙凤无发开关门问间书长张万与亿过还让变应该点';

function strictDecode(buf: Buffer, enc: SupportedEncoding): string | null {
  try {
    return new TextDecoder(enc, { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return null;
  }
}

function countChars(text: string, set: string): number {
  let n = 0;
  for (const ch of set) n += text.split(ch).length - 1;
  return n;
}

export type EncodingErrorCode = 'ENCODING_UNDETERMINED' | 'ENCODING_REQUESTED_INVALID';

export class EncodingError extends Error {
  code: EncodingErrorCode;
  constructor(code: EncodingErrorCode) {
    super(code);
    this.code = code;
  }
}

// `requested` is an explicit Admin override (reanalyze); it must decode
// strictly or we refuse rather than import mojibake.
export function decodeTxt(buf: Buffer, requested?: string | null): EncodingResult {
  if (requested) {
    const enc = requested.toLowerCase() as SupportedEncoding;
    if (!['utf-8', 'utf-16le', 'utf-16be', 'big5', 'gb18030'].includes(enc)) {
      throw new EncodingError('ENCODING_REQUESTED_INVALID');
    }
    const text = strictDecode(buf, enc);
    if (text === null) throw new EncodingError('ENCODING_REQUESTED_INVALID');
    return { encoding: enc, confidence: 'high', reason: 'admin override', warnings: [], text };
  }

  // --- BOM: authoritative ------------------------------------------------------
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', confidence: 'bom', reason: 'UTF-8 BOM', warnings: [], text: strictDecode(buf.subarray(3), 'utf-8')! };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16le', confidence: 'bom', reason: 'UTF-16 LE BOM', warnings: [], text: strictDecode(buf.subarray(2), 'utf-16le')! };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', confidence: 'bom', reason: 'UTF-16 BE BOM', warnings: [], text: strictDecode(buf.subarray(2), 'utf-16be')! };
  }

  // --- UTF-8 strict validation -------------------------------------------------
  const utf8 = strictDecode(buf, 'utf-8');
  if (utf8 !== null) {
    const hasNonAscii = buf.some((b) => b >= 0x80);
    // pure ASCII is byte-identical in all target encodings; report as utf-8
    return {
      encoding: 'utf-8', confidence: 'high',
      reason: hasNonAscii ? 'strict UTF-8 validation passed' : 'pure ASCII (valid UTF-8)',
      warnings: [], text: utf8,
    };
  }

  // --- UTF-16 without BOM: null-byte ratio ------------------------------------
  // CJK UTF-16 has ~50% null bytes; 8-bit encodings have ~0%.
  const nulls = buf.filter((b) => b === 0).length / buf.length;
  if (nulls > 0.3) {
    const le = strictDecode(buf, 'utf-16le');
    const be = strictDecode(buf, 'utf-16be');
    // utf-16le CJK text decoded as BE yields CJK-complement garbage that is
    // still "valid"; distinguish by which side has the nulls in ASCII ranges
    const leNullsFirst = buf.filter((b, i) => i % 2 === 1 && b === 0).length;
    const beNullsFirst = buf.filter((b, i) => i % 2 === 0 && b === 0).length;
    if (leNullsFirst > beNullsFirst && le !== null) {
      return { encoding: 'utf-16le', confidence: 'medium', reason: 'no BOM; null-byte parity suggests LE', warnings: ['UTF-16 detected without BOM — please verify the preview'], text: le };
    }
    if (beNullsFirst > leNullsFirst && be !== null) {
      return { encoding: 'utf-16be', confidence: 'medium', reason: 'no BOM; null-byte parity suggests BE', warnings: ['UTF-16 detected without BOM — please verify the preview'], text: be };
    }
  }

  // --- Big5 vs GB18030 ---------------------------------------------------------
  const big5 = strictDecode(buf, 'big5');
  const gb = strictDecode(buf, 'gb18030');
  if (big5 === null && gb === null) throw new EncodingError('ENCODING_UNDETERMINED');
  if (big5 !== null && gb === null) {
    return { encoding: 'big5', confidence: 'medium', reason: 'valid Big5, invalid GB18030', warnings: [], text: big5 };
  }
  if (big5 === null && gb !== null) {
    return { encoding: 'gb18030', confidence: 'medium', reason: 'valid GB18030, invalid Big5', warnings: [], text: gb };
  }
  // both decode cleanly — score each decode against its own script set
  const sample = (s: string) => s.slice(0, 5000);
  const trad = countChars(sample(big5!), TRAD_ONLY);
  const simp = countChars(sample(gb!), SIMP_ONLY);
  if (trad > simp * 2 && trad > 0) {
    return { encoding: 'big5', confidence: 'medium', reason: `both valid; Traditional chars ${trad} vs Simplified ${simp}`, warnings: ['Big5/GB18030 ambiguous — please verify the preview'], text: big5! };
  }
  if (simp > trad * 2 && simp > 0) {
    return { encoding: 'gb18030', confidence: 'medium', reason: `both valid; Simplified chars ${simp} vs Traditional ${trad}`, warnings: ['Big5/GB18030 ambiguous — please verify the preview'], text: gb! };
  }
  // genuinely ambiguous: guess nothing — surface for review with the more
  // common Taiwan/HK source encoding, but confidence=low forces review_required
  return {
    encoding: 'big5', confidence: 'low',
    reason: 'Big5 and GB18030 both valid with no script evidence',
    warnings: ['無法可靠判斷編碼（Big5／GB18030 皆有效）——請人工確認'],
    text: big5!,
  };
}
