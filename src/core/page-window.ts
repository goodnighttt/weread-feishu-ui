declare const unsafeWindow: Window & typeof globalThis;

export const pageWindow: Window & typeof globalThis =
  typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
