import type { PageKind } from './types';

export function detectPage(path = location.pathname): PageKind {
  if (path.startsWith('/web/reader/')) return 'reader';
  if (
    path === '/' ||
    path === '/web' ||
    path.startsWith('/web/shelf') ||
    path.startsWith('/web/search') ||
    path.startsWith('/web/category')
  ) return 'home';
  return 'none';
}

export function patchHistory(onChange: () => void): void {
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method] as typeof history.pushState & { __wrfPatched?: boolean };
    if (original.__wrfPatched) continue;
    const wrapped = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      queueMicrotask(onChange);
      return result;
    } as typeof history.pushState & { __wrfPatched?: boolean };
    wrapped.__wrfPatched = true;
    history[method] = wrapped as never;
  }
  window.addEventListener('popstate', onChange, { passive: true });
}
