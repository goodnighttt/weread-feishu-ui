import { getCanvasEntries } from './canvas-capture';

const CONTENT_LOG = '[微信读书·飞书UI][正文]';
let reported = false;
let timer = 0;

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

function reportSource(): void {
  if (!location.pathname.startsWith('/web/reader/')) return;
  const canvas = canvasStats();
  if (!canvas.usable) return;
  document.documentElement.dataset.wrfContentSource = 'canvas';
  if (reported) return;
  reported = true;
  console.info(`${CONTENT_LOG} 当前来源：Canvas 捕获`, {
    '来源': 'Canvas 捕获',
    '捕获记录': canvas.records,
    '恢复行数': canvas.lines,
  });
}

export function installReaderContentSourceDiagnostics(): void {
  window.clearInterval(timer);
  reported = false;
  reportSource();
  timer = window.setInterval(reportSource, 1000);
}
