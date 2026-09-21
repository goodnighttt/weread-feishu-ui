import { canonicalBookTitle, getReaderMeta } from '../adapter/weread';
import { cleanText, escapeHtml } from '../core/dom';
import { pageWindow } from '../core/page-window';
import type { ReaderBlock } from '../core/types';
import { getCanvasEntries } from './canvas-capture';

interface ReaderLine {
  text: string;
  x: number;
  y: number;
  fontPx: number;
  font: string;
}

function parseFontPx(font = ''): number {
  const match = String(font).match(/([\d.]+)px/i);
  return match ? Number(match[1]) || 16 : 16;
}

function shouldInsertSpace(left = '', right = '', gap = 0, fontPx = 16): boolean {
  if (gap < Math.max(2, fontPx * 0.16)) return false;
  return /[A-Za-z0-9_)\]]$/.test(left) && /^[A-Za-z0-9_(\[]/.test(right);
}

function getCapturedReaderLines(): ReaderLine[] {
  const entries = getCanvasEntries();
  const fragments: Array<ReaderLine & { width: number; align?: string }> = [];

  for (const { canvas, record } of entries) {
    if (!canvas.closest('.readerContent, .app_content, .readerChapterContent')) continue;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20 || !canvas.width || !canvas.height) continue;
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    const fontPx = parseFontPx(record.font) * (record.scale || 1) * scaleY;
    const width = record.width * scaleX;
    let x = rect.left + record.x * scaleX;
    if (record.align === 'center') x -= width / 2;
    else if (record.align === 'right' || record.align === 'end') x -= width;
    fragments.push({
      text: cleanText(record.text),
      x,
      y: rect.top + window.scrollY + record.y * scaleY,
      width,
      fontPx,
      font: record.font,
      align: record.align,
    });
  }

  fragments.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Array<{ y: number; fragments: typeof fragments; fontPx: number; font: string }> = [];
  for (const fragment of fragments) {
    if (!fragment.text) continue;
    let row = rows[rows.length - 1];
    const tolerance = Math.max(3, fragment.fontPx * 0.22);
    if (!row || Math.abs(row.y - fragment.y) > tolerance) {
      row = { y: fragment.y, fragments: [], fontPx: fragment.fontPx, font: fragment.font };
      rows.push(row);
    }
    const duplicate = row.fragments.some((item) => Math.abs(item.x - fragment.x) < 1.5 && item.text === fragment.text);
    if (!duplicate) row.fragments.push(fragment);
    row.fontPx = Math.max(row.fontPx, fragment.fontPx);
  }

  const seen = new Set<string>();
  const lines: ReaderLine[] = [];
  for (const row of rows) {
    row.fragments.sort((a, b) => a.x - b.x);
    let text = '';
    let previousEnd: number | null = null;
    for (const fragment of row.fragments) {
      const gap = previousEnd == null ? 0 : fragment.x - previousEnd;
      if (text && shouldInsertSpace(text, fragment.text, gap, row.fontPx)) text += ' ';
      if (!text.endsWith(fragment.text) || fragment.text.length > 1) text += fragment.text;
      previousEnd = Math.max(previousEnd ?? -Infinity, fragment.x + Math.max(fragment.width, 1));
    }
    text = cleanText(text);
    if (!text || text.length > 1000) continue;
    const signature = `${Math.round(row.y / 3)}|${text}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    lines.push({ text, y: row.y, x: row.fragments[0]?.x || 0, fontPx: row.fontPx, font: row.font });
  }
  return lines;
}

function getInitialStateReaderBlocks(): ReaderBlock[] {
  let reader: any = null;
  try { reader = (pageWindow as any).__INITIAL_STATE__?.reader || null; } catch { /* noop */ }
  if (!reader) return [];
  const candidates = [
    reader.currentChapter?.content,
    reader.currentChapter?.html,
    reader.chapterData?.content,
    reader.chapterContent,
    reader.content,
  ].filter((value) => typeof value === 'string' && value.trim().length > 20) as string[];
  if (!candidates.length) return [];

  const source = [...candidates].sort((a, b) => b.length - a.length)[0];
  if (!/[<>]/.test(source)) {
    return source.split(/\n{2,}|\r\n{2,}/)
      .map((text): ReaderBlock => ({ type: 'p', text: cleanText(text) }))
      .filter((block) => block.text);
  }

  try {
    const doc = new DOMParser().parseFromString(`<div id="wrf-source">${source}</div>`, 'text/html');
    const root = doc.getElementById('wrf-source');
    root?.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
    const blocks: ReaderBlock[] = [];
    for (const node of root?.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,pre,li') || []) {
      const text = cleanText(node.textContent || '');
      if (!text) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === 'h1' || tag === 'h2') blocks.push({ type: 'h2', text });
      else if (/^h[3-6]$/.test(tag)) blocks.push({ type: 'h3', text });
      else if (tag === 'blockquote') blocks.push({ type: 'quote', text });
      else if (tag === 'pre') blocks.push({ type: 'code', text: node.textContent || '' });
      else blocks.push({ type: 'p', text });
    }
    return blocks;
  } catch {
    return [];
  }
}

function getNativeReaderLines(): ReaderLine[] {
  const root = document.querySelector('.readerChapterContent');
  const source = (root as HTMLElement | null)?.innerText || root?.textContent || '';
  if (!cleanText(source) || source.length < 20) return [];
  return source.split(/\n+/)
    .map((value, index) => ({ text: cleanText(value), y: index * 30, x: 0, fontPx: 16, font: '' }))
    .filter((item) => item.text);
}

export function getReaderBlocks(): ReaderBlock[] {
  const semantic = getInitialStateReaderBlocks();
  if (semantic.length >= 2) return semantic.slice(0, 800);

  const meta = getReaderMeta();
  let lines = getCapturedReaderLines();
  if (lines.length < 3) lines = getNativeReaderLines();
  if (!lines.length) return [];

  const fontValues = lines.map((line) => line.fontPx).filter((value) => value >= 8 && value <= 64).sort((a, b) => a - b);
  const bodyFont = fontValues[Math.floor(fontValues.length * 0.45)] || 16;
  const ignored = ['上一章', '下一章', '目录', '笔记', '阅读设置', '返回顶部', '微信读书'];
  const chapterKey = canonicalBookTitle(meta.chapter);
  const bookKey = canonicalBookTitle(meta.book);
  const filtered = lines.filter((line) => {
    const key = canonicalBookTitle(line.text);
    return Boolean(key) && key !== chapterKey && key !== bookKey && !ignored.includes(line.text);
  });

  const blocks: ReaderBlock[] = [];
  let paragraph: ReaderLine[] = [];
  let paragraphLast: ReaderLine | null = null;
  const flush = () => {
    if (!paragraph.length) return;
    let value = '';
    for (const line of paragraph) {
      if (!value) value = line.text;
      else if (/[A-Za-z0-9,.;:!?)]$/.test(value) && /^[A-Za-z0-9([]/.test(line.text)) value += ` ${line.text}`;
      else value += line.text;
    }
    value = cleanText(value);
    if (value) blocks.push({ type: 'p', text: value });
    paragraph = [];
    paragraphLast = null;
  };

  for (const line of filtered) {
    const isMono = /mono|consolas|courier/i.test(line.font || '');
    const isHeading = line.text.length <= 90 && line.fontPx >= bodyFont * 1.24;
    if (isHeading || isMono || /^>\s?/.test(line.text)) {
      flush();
      if (isMono) blocks.push({ type: 'code', text: line.text });
      else if (/^>\s?/.test(line.text)) blocks.push({ type: 'quote', text: line.text.replace(/^>\s?/, '') });
      else blocks.push({ type: line.fontPx >= bodyFont * 1.55 ? 'h2' : 'h3', text: line.text });
      continue;
    }
    if (paragraphLast) {
      const gap = line.y - paragraphLast.y;
      const indentDelta = Math.abs(line.x - paragraph[0].x);
      if (gap > Math.max(bodyFont * 2.05, 31) || indentDelta > bodyFont * 2.6) flush();
    }
    paragraph.push(line);
    paragraphLast = line;
  }
  flush();

  return blocks.filter((block, index, list) => {
    const previous = list[index - 1];
    return !previous || previous.type !== block.type || previous.text !== block.text;
  }).slice(0, 800);
}

export function readerBlocksHtml(blocks: ReaderBlock[]): string {
  if (!blocks.length) {
    return '<div class="wrf-article-loading">正在把微信读书正文转换成飞书文档排版…<br>如果刚进入章节，请等待正文完成渲染。</div>';
  }
  return blocks.map((block) => {
    const text = escapeHtml(block.text);
    if (block.type === 'h2') return `<h2 class="wrf-md-h2">${text}</h2>`;
    if (block.type === 'h3') return `<h3 class="wrf-md-h3">${text}</h3>`;
    if (block.type === 'quote') return `<blockquote class="wrf-md-quote">${text}</blockquote>`;
    if (block.type === 'code') return `<pre class="wrf-md-code">${text}</pre>`;
    return `<p class="wrf-md-p">${text}</p>`;
  }).join('');
}
