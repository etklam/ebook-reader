// Vocabulary overrides for the Simplified UI.
//
// opencc-js converts *characters*, not words: with `from: 't'` it applies no
// phrase dictionary at all, so 設定 becomes 设定 and 搜尋 becomes 搜寻 — both
// legible, neither what a Simplified-reading user expects to see on a button.
// A few UI words also simply do not survive character mapping: 工具列, 介面 and
// 伺服器 come out unchanged, and 暱稱 becomes the non-word 暱称.
//
// So the pipeline is: substitute these phrases first, then let opencc handle
// every remaining character. Replacements are written in Simplified already and
// pass through opencc unchanged (verified in translate.test.ts), which keeps
// this one map as the only place UI wording differs between the two locales.
//
// This is deliberately a *UI* dictionary. Chapter prose is never routed through
// it — reader/conversion.ts does that with plain opencc, because rewriting an
// author's words is not a localization decision (ADR-07).
export const ZH_HANS_VOCABULARY: Readonly<Record<string, string>> = {
  介面: '界面',
  偵測: '检测',
  儲存: '保存',
  關鍵字: '关键词',
  匯入: '导入',
  匯出: '导出',
  捲動: '滚动',
  搜尋: '搜索',
  檔案: '文件',
  檢視: '查看',
  清單: '列表',
  登入: '登录',
  空白鍵: '空格键',
  網路: '网络',
  繁簡: '繁简',
  伺服器: '服务器',
  品質: '质量',
  導覽: '导航',
  復原: '撤销',
  工具列: '工具栏',
  帳號: '账号',
  暱稱: '昵称',
  裝置: '设备',
  貼上: '粘贴',
  載入: '加载',
  連結: '链接',
  連線: '连接',
  設定: '设置',
  預設: '默认',
};

// Longest key first, so 空白鍵 is matched before any shorter key that could
// overlap it and 載入 does not pre-empt a future 載入中 entry.
const PATTERN = new RegExp(
  Object.keys(ZH_HANS_VOCABULARY)
    .sort((a, b) => b.length - a.length)
    .join('|'),
  'g',
);

export function applyVocabulary(text: string): string {
  return text.replace(PATTERN, (word) => ZH_HANS_VOCABULARY[word] ?? word);
}
