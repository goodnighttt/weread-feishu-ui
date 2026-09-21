import { cleanText } from '../core/dom';
import { pageWindow } from '../core/page-window';
import { state } from '../core/state';
import type { CanvasRecord } from '../core/types';

let refreshCallback: (() => void) | null = null;

function scheduleCanvasRefresh(): void {
  window.clearTimeout(state.canvasRefreshTimer);
  state.canvasRefreshTimer = window.setTimeout(() => {
    if (state.enabled && state.page === 'reader') refreshCallback?.();
  }, 180);
}

function captureCanvasText(ctx: CanvasRenderingContext2D, text: unknown, x: unknown, y: unknown): void {
  if (!location.pathname.startsWith('/web/reader/')) return;
  const canvas = ctx.canvas;
  const value = cleanText(String(text ?? ''));
  if (!canvas || value.length === 0 || value.length > 800) return;

  let bucket = state.canvasCapture.get(canvas);
  if (!bucket) {
    bucket = { records: new Map(), updatedAt: 0 };
    state.canvasCapture.set(canvas, bucket);
  }

  const font = String(ctx.font || '16px sans-serif');
  let drawX = Number(x) || 0;
  let drawY = Number(y) || 0;
  let scale = 1;
  try {
    const matrix = ctx.getTransform();
    const originalX = drawX;
    const originalY = drawY;
    drawX = matrix.a * originalX + matrix.c * originalY + matrix.e;
    drawY = matrix.b * originalX + matrix.d * originalY + matrix.f;
    scale = Math.max(0.01, Math.hypot(matrix.a, matrix.b));
  } catch {
    // Older canvas implementations may not expose getTransform.
  }

  const key = `${Math.round(drawX)}|${Math.round(drawY)}|${font}|${value}`;
  bucket.records.set(key, {
    text: value,
    x: drawX,
    y: drawY,
    font,
    scale,
    align: String(ctx.textAlign || 'start'),
    width: (() => {
      try { return (ctx.measureText(value).width || 0) * scale; }
      catch { return 0; }
    })(),
  });
  bucket.updatedAt = Date.now();
  scheduleCanvasRefresh();
}

export function installCanvasCapture(onRefresh: () => void): void {
  refreshCallback = onRefresh;
  const proto = pageWindow.CanvasRenderingContext2D?.prototype as (CanvasRenderingContext2D & {
    __wrfCaptureInstalled?: boolean;
  }) | undefined;
  if (!proto || proto.__wrfCaptureInstalled) return;
  proto.__wrfCaptureInstalled = true;

  const originalFillText = proto.fillText;
  proto.fillText = function (...args: Parameters<CanvasRenderingContext2D['fillText']>) {
    try { captureCanvasText(this, args[0], args[1], args[2]); } catch { /* noop */ }
    return originalFillText.apply(this, args);
  };

  if (typeof proto.strokeText === 'function') {
    const originalStrokeText = proto.strokeText;
    proto.strokeText = function (...args: Parameters<CanvasRenderingContext2D['strokeText']>) {
      try { captureCanvasText(this, args[0], args[1], args[2]); } catch { /* noop */ }
      return originalStrokeText.apply(this, args);
    };
  }
}

export function clearCanvasCapture(): void {
  state.canvasCapture.clear();
}

export function getCanvasEntries(): Array<{ canvas: HTMLCanvasElement; record: CanvasRecord }> {
  const entries: Array<{ canvas: HTMLCanvasElement; record: CanvasRecord }> = [];
  for (const [canvas, bucket] of [...state.canvasCapture.entries()]) {
    if (!canvas.isConnected) {
      state.canvasCapture.delete(canvas);
      continue;
    }
    for (const record of bucket.records.values()) entries.push({ canvas, record });
  }
  return entries;
}
