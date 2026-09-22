declare const unsafeWindow: Window & typeof globalThis;

export const pageWindow: Window & typeof globalThis =
  typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

export const alreadyRunning = Boolean((pageWindow as any).__wrFeishuUIRunning);
if (!alreadyRunning) (pageWindow as any).__wrFeishuUIRunning = true;
