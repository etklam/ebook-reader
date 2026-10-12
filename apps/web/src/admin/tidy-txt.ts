export interface TidyOptions {
  trimLines: boolean;
  collapseBlankLines: boolean;
  removePromotions: boolean;
  joinWrappedLines: boolean;
}

export const DEFAULT_TIDY_OPTIONS: TidyOptions = {
  trimLines: true,
  collapseBlankLines: true,
  removePromotions: false,
  joinWrappedLines: false,
};

export interface TidyResult {
  text: string;
  trimmedLines: number;
  collapsedBlankLines: number;
  removedPromotionLines: number;
  joinedLines: number;
}

const AD_LINE = /^\s*(?:本[書书]由.{1,30}(?:整理|收集)|[請请]搜索.{1,30}(?:小說|小说)|更多精彩.{1,30}|最新網址[:：]?\s*\S+|最新网址[:：]?\s*\S+|https?:\/\/\S+|www\.\S+)\s*$/i;
const HEADING_LINE = /^\s*(?:[第卷][0-9０-９.．一二三四五六七八九十零〇百千两兩]*[章回幕部節节集卷]|序章|序幕|楔子|引子|[終终]章|尾[聲声]|[後后][記记]|大[結结]局|番外|外[傳传]|附[錄录])/;
const METADATA_LINE = /^\s*(?:作品名|書名|书名|作者|簡介|简介|內容簡介|内容简介|狀態|状态|連載狀態|连载状态|title|author|description|status)\s*[:：]/i;
const END_PUNCTUATION = /[。！？!?；;…」』）》】]$/;
const OPENING_MARK = /^[「『（(《【]/;

function wrappedLineCanJoin(previous: string, next: string): boolean {
  return previous.length > 0 && previous.length <= 60 && next.length > 0 && next.length <= 60 &&
    !END_PUNCTUATION.test(previous) && !HEADING_LINE.test(previous) && !HEADING_LINE.test(next) &&
    !METADATA_LINE.test(previous) && !METADATA_LINE.test(next) &&
    !OPENING_MARK.test(next) && !/^\s*(?:[-*•]|\d+[.、])/.test(next);
}

/** Conservative, preview-first TXT cleanup. This never runs without an explicit apply click. */
export function tidyTxt(source: string, options: TidyOptions): TidyResult {
  const originalLines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let trimmedLines = 0;
  let removedPromotionLines = 0;
  const lines = originalLines.flatMap((line) => {
    if (options.removePromotions && AD_LINE.test(line)) { removedPromotionLines++; return []; }
    if (!options.trimLines) return [line];
    const clean = line.trim();
    if (clean !== line) trimmedLines++;
    return [clean];
  });

  let collapsedBlankLines = 0;
  const spaced: string[] = [];
  for (const line of lines) {
    if (options.collapseBlankLines && line === '' && spaced.at(-1) === '') {
      collapsedBlankLines++;
      continue;
    }
    spaced.push(line);
  }

  let joinedLines = 0;
  let output = spaced;
  if (options.joinWrappedLines) {
    output = [];
    let previousPhysicalLine = '';
    for (const line of spaced) {
      if (!line) {
        output.push('');
        previousPhysicalLine = '';
        continue;
      }
      const previousOutput = output.at(-1);
      if (previousOutput && previousPhysicalLine && wrappedLineCanJoin(previousPhysicalLine, line)) {
        output[output.length - 1] += /^[\x00-\x7f]/.test(line) && /[\x00-\x7f]$/.test(previousPhysicalLine) ? ' ' + line : line;
        joinedLines++;
      } else output.push(line);
      previousPhysicalLine = line;
    }
  }

  return {
    text: output.join('\n').replace(/^\n+|\n+$/g, ''),
    trimmedLines, collapsedBlankLines, removedPromotionLines, joinedLines,
  };
}
