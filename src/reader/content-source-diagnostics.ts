import { cleanText } from '../core/dom';
import { pageWindow } from '../core/page-window';
import { getCanvasEntries } from './canvas-capture';

type ReaderContentSource = 'DOM 坐标提取' | 'INITIAL_STATE 正文' | 'Canvas 兜底' | '普通 DOM 兜底';

const CONTENT_LOG = '[微信读书·飞书UI][正文]';
let lastSource = '';
let timer = 0;

function positionedDomStats(): { usable: boolean; nodes: number; characters: number } {
  const root = document.querySelector('.readerChapterContent');
  if (!root) return { usable: false, nodes: 0, characters: 0 };
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-wr-role="text"]')]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && Boolean(cleanText(element.textContent || ''));
    });
  const characters = nodes.reduce((sum, node) => sum + cleanText(node.textContent || '').length, 0);
  return { usable: characters >= 20, nodes: nodes.length, characters };
}

function initialStateStats(): { usable: boolean; blocks: number } {
  let reader: any = null;
  try { reader = (pageWindow as any).__INITIAL_STATE__?.reader || null; } catch { /* ignore */ }
  if (!reader) return { usable: false, blocks: 0 };
  const candidates = [
    reader.currentChapter?.content,
    reader.currentChapter?.html,
    reader.chapterData?.content,
    reader.chapterContent,
    reader.content,
  ].filter((value) => typeof value === 'string' && value.trim().length > 20) as string[];
  if (!candidates.length) return { usable: false, blocks: 0 };
  const source = [...candidates].sort((a, b) => b.length - a.length)[0];
  if (!/[<>]/.test(source)) {
    const blocks = source.split(/\n{2,}|\r\n{2,}/).map(cleanText).filter(Boolean).length;
    return { usable: blocks >= 2, blocks };
  }
  try {
    const doc = new DOMParser().parseFromString(`<div id="wrf-source">${source}</div>`, 'text/html');
    const root = doc.getElementById('wrf-source');
    root?.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
    const blocks = [...(root?.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,pre,li') || [])]
      .filter((node) => Boolean(cleanText(node.textContent || ''))).length;
    return { usable: blocks >= 2, blocks };
  } catch {
    return { usable: false, blocks: 0 };
  }
}

function canvasStats(): { usable: boolean; lines: number; records: number } {
  const rows: number[] = [];
  let records = 0;
  for (const { canvas, record } of getCanvasEntries()) {
    if (!canvas.closest('.readerContent, .app_content, .readerChapterContent')) continue;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20 || !canvas.width || !canvas.height) continue;
    const scaleY = rect.height / canvas.height;
    const y = rect.top + window.scrollY + record.y * scaleY;
    const fontMatch = String(record.font || '').match(/([\d.]+)px/i);
    const fontPx = (fontMatch ? Number(fontMatch[1]) || 16 : 16) * (record.scale || 1) * scaleY;
    const tolerance = Math.max(3, fontPx * 0.22);
    records += 1;
    if (!rows.some((rowY) => Math.abs(rowY - y) <= tolerance)) rows.push(y);
  }
  return { usable: rows.length >= 3, lines: rows.length, records };
}

function nativeDomStats(): { usable: boolean; characters: number } {
  const root = document.querySelector('.readerChapterContent');
  const source = (root as HTMLElement | null)?.innerText || root?.textContent || '';
  const characters = cleanText(source).length;
  return { usable: characters >= 20, characters };
}

function detectSource(): { source: ReaderContentSource; details: Record<string, unknown>; marker: string } | null {
  if (!location.pathname.startsWith('/web/reader/')) return null;

  const positioned = positionedDomStats();
  if (positioned.usable) {
    return {
      source: 'DOM 坐标提取',
      marker: 'dom-position',
      details: { '文字节点': positioned.nodes, '字符数': positioned.characters },
    };
  }

  const initial = initialStateStats();
  if (initial.usable) {
    return {
      source: 'INITIAL_STATE 正文',
      marker: 'initial-state',
      details: { '内容块': initial.blocks },
    };
  }

  const canvas = canvasStats();
  if (canvas.usable) {
    return {
      source: 'Canvas 兜底',
      marker: 'canvas',
      details: { '捕获记录': canvas.records, '恢复行数': canvas.lines },
    };
  }

  const native = nativeDomStats();
  if (native.usable) {
    return {
      source: '普通 DOM 兜底',
      marker: 'native-dom',
      details: { '字符数': native.characters },
    };
  }
  return null;
}

function reportSource(): void {
  const result = detectSource();
  if (!result) return;
  document.documentElement.dataset.wrfContentSource = result.marker;
  if (result.source === lastSource) return;
  lastSource = result.source;
  console.info(`${CONTENT_LOG} 当前来源：${result.source}`, {
    '来源': result.source,
    ...result.details,
  });
}

export function installReaderContentSourceDiagnostics(): void {
  window.clearInterval(timer);
  reportSource();
  timer = window.setInterval(reportSource, 1000);
}
