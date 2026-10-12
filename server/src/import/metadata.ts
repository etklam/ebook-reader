export interface ImportMetadata {
  title?: string;
  author?: string;
  description?: string;
  serialStatus?: 'ongoing' | 'completed';
}

export function completionStatus(text: string): ImportMetadata['serialStatus'] {
  if (/未完[結结]|未完成|連載|连载|ongoing/i.test(text)) return 'ongoing';
  if (/完[結结]|全本|completed/i.test(text)) return 'completed';
  return undefined;
}

// Only explicit front matter is trusted; missing fields remain editable blanks.
export function extractTxtMetadata(text: string): ImportMetadata {
  const metadata: ImportMetadata = {};
  let inDescription = false;
  const description: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').slice(0, 16000).split('\n').slice(0, 150)) {
    const line = raw.trim().replace(/^\uFEFF/, '');
    if (/^[第卷][0-9０-９一二三四五六七八九十零〇百千两兩]*[章回幕部節节集卷]/.test(line)) break;
    const field = line.match(/^(書名|书名|作品名(?:稱|称)?|作者|簡介|简介|內容簡介|内容简介|狀態|状态|連載狀態|连载状态|title|author|description|status)\s*[:：]\s*(.*)$/i);
    if (field) {
      inDescription = false;
      const [, name, value] = field;
      if (/^(書名|书名|作品名|title)/i.test(name)) metadata.title = value.slice(0, 300);
      else if (/^(作者|author)$/i.test(name)) metadata.author = value.slice(0, 300);
      else if (/簡介|简介|description/i.test(name)) { inDescription = true; description.push(value); }
      else metadata.serialStatus = completionStatus(value);
    } else if (inDescription) {
      description.push(line);
    } else {
      const title = line.match(/^《([^》]+)》(?:\s*作者\s*[:：]\s*(.+))?$/);
      if (title) { metadata.title ??= title[1]; if (title[2]) metadata.author ??= title[2]; }
    }
  }
  if (description.length) metadata.description = description.join('\n').trim().slice(0, 5000);
  return metadata;
}
