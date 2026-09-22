import { state } from '../core/state';

const LOAD_LOG = '[微信读书·飞书UI][正文续载]';
const BOTTOM_THRESHOLD = 240;
const RETRY_DELAY = 600;
const DEMAND_WINDOW = 6000;
const MIN_USEFUL_RANGE = 120;

let lastReaderUrl = '';
let loggedReaderUrl = '';
let pendingFrame = 0;
let retryTimer = 0;
let demandUntil = 0;
let markedScroller: HTMLElement | null = null;
let cachedScroller: NativeScroller | null = null;

type NativeScroller = {
  element: HTMLElement;
  isDocument: boolean;
  label: string;
  candidates: string[];
};

function resetForReaderUrl(): void {
  if (lastReaderUrl === location.href) return;
  lastReaderUrl = location.href;
  loggedReaderUrl = '';
  demandUntil = 0;
  cachedScroller = null;
  window.clearTimeout(retryTimer);
  retryTimer = 0;
}

function isNearBottom(main: HTMLElement): boolean {
  return main.scrollHeight - main.clientHeight - main.scrollTop <= BOTTOM_THRESHOLD;
}

function describeElement(element: HTMLElement): string {
  if (element === document.documentElement) return 'html / 页面滚动';
  if (element === document.body) return 'body / 页面滚动';
  const id = element.id ? `#${element.id}` : '';
  const className = typeof element.className === 'string'
    ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 4).map((name) => `.${name}`).join('')
    : '';
  return `${element.tagName.toLowerCase()}${id}${className}`;
}

function elementRange(element: HTMLElement): number {
  if (element === document.documentElement || element === document.body) {
    return Math.max(0, element.scrollHeight - window.innerHeight);
  }
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function canProgrammaticallyScroll(element: HTMLElement): boolean {
  const max = elementRange(element);
  if (max <= 8) return false;
  if (element === document.documentElement || element === document.body) return true;

  const original = element.scrollTop;
  const target = original < max ? Math.min(max, original + 1) : Math.max(0, original - 1);
  if (target === original) return false;

  try {
    element.scrollTop = target;
    const changed = Math.abs(element.scrollTop - original) > 0;
    element.scrollTop = original;
    return changed;
  } catch {
    return false;
  }
}

function isIgnoredNativeArea(element: HTMLElement): boolean {
  return Boolean(element.closest('.readerCatalog, .readerNotePanel, .readerControls'));
}

function collectNativeScrollerCandidates(): Array<{ element: HTMLElement; range: number }> {
  const candidates = new Map<HTMLElement, number>();
  const add = (element: HTMLElement | null) => {
    if (!element || isIgnoredNativeArea(element)) return;
    const range = elementRange(element);
    if (range <= 8) return;
    const previous = candidates.get(element) || 0;
    if (range > previous) candidates.set(element, range);
  };

  const chapter = document.querySelector<HTMLElement>('.readerChapterContent');
  const readerContent = document.querySelector<HTMLElement>('.readerContent');

  // 1) 正文自身与所有祖先。旧版只看 overflow:auto/scroll，容易漏掉 JS 可滚动但 CSS 隐藏滚动条的容器。
  let current: HTMLElement | null = chapter || readerContent;
  while (current) {
    add(current);
    if (current === document.body || current === document.documentElement) break;
    current = current.parentElement;
  }

  // 2) 微信读书常见的阅读器容器。
  for (const selector of ['.reader_main', '.readerContent', '.readerChapterContent_container', '.app_content', '#routerView']) {
    document.querySelectorAll<HTMLElement>(selector).forEach(add);
  }

  // 3) 如果常见容器仍没有明显滚动范围，再扫描 readerContent 内的块级候选。
  if (![...candidates.values()].some((range) => range >= MIN_USEFUL_RANGE) && readerContent) {
    readerContent.querySelectorAll<HTMLElement>('div,main,section,article').forEach((element) => {
      if (element.clientHeight < 80) return;
      add(element);
    });
  }

  const scrollingElement = (document.scrollingElement || document.documentElement) as HTMLElement;
  add(scrollingElement);
  if (document.body) add(document.body);

  return [...candidates.entries()]
    .map(([element, range]) => ({ element, range }))
    .filter(({ element }) => canProgrammaticallyScroll(element))
    .sort((a, b) => b.range - a.range);
}

function findNativeScroller(): NativeScroller {
  if (cachedScroller?.element.isConnected && elementRange(cachedScroller.element) > 8) return cachedScroller;

  const candidates = collectNativeScrollerCandidates();
  const useful = candidates.find(({ range }) => range >= MIN_USEFUL_RANGE) || candidates[0];
  const fallback = (document.scrollingElement || document.documentElement) as HTMLElement;
  const element = useful?.element || fallback;
  const isDocument = element === document.documentElement || element === document.body || element === document.scrollingElement;

  cachedScroller = {
    element,
    isDocument,
    label: describeElement(element),
    candidates: candidates.slice(0, 6).map(({ element: item, range }) => `${describeElement(item)}：${range}px`),
  };
  return cachedScroller;
}

function markNativeScroller(scroller: NativeScroller): void {
  if (markedScroller === scroller.element) return;
  markedScroller?.removeAttribute('data-wrf-native-scroll-driver');
  markedScroller = scroller.element;
  markedScroller.setAttribute('data-wrf-native-scroll-driver', '');
}

function getNativeMetrics(scroller: NativeScroller): { top: number; max: number } {
  if (scroller.isDocument) {
    const element = scroller.element;
    return {
      top: Math.max(window.scrollY, element.scrollTop || 0),
      max: Math.max(0, element.scrollHeight - window.innerHeight),
    };
  }
  return {
    top: scroller.element.scrollTop,
    max: Math.max(0, scroller.element.scrollHeight - scroller.element.clientHeight),
  };
}

function setNativeScroll(scroller: NativeScroller, top: number): void {
  if (scroller.isDocument) {
    window.scrollTo({ left: window.scrollX, top, behavior: 'auto' });
    return;
  }
  scroller.element.scrollTo({ left: scroller.element.scrollLeft, top, behavior: 'auto' });
}

function syncNativeProgress(main: HTMLElement): void {
  resetForReaderUrl();
  if (!state.enabled || state.page !== 'reader' || !main.isConnected) return;

  const overlayMax = Math.max(1, main.scrollHeight - main.clientHeight);
  const remaining = main.scrollHeight - main.clientHeight - main.scrollTop;
  const progress = remaining <= BOTTOM_THRESHOLD
    ? 1
    : Math.max(0, Math.min(1, main.scrollTop / overlayMax));

  const scroller = findNativeScroller();
  markNativeScroller(scroller);
  const metrics = getNativeMetrics(scroller);

  // 虚拟阅读器可能在滚动后替换真正的滚动节点；当前节点范围异常小时重新探测。
  if (metrics.max < MIN_USEFUL_RANGE) {
    cachedScroller = null;
    scheduleRetry(main);
  } else {
    const target = progress >= 0.995 ? metrics.max : Math.round(metrics.max * progress);
    if (Math.abs(target - metrics.top) > 2) setNativeScroll(scroller, target);
  }

  if (loggedReaderUrl !== lastReaderUrl) {
    loggedReaderUrl = lastReaderUrl;
    console.info(`${LOAD_LOG} 已同步原生阅读进度`, {
      '原生滚动容器': scroller.label,
      '飞书进度': `${Math.round(progress * 100)}%`,
      '原生滚动范围': `${metrics.max}px`,
      '候选滚动容器': scroller.candidates,
      '底部自动重试': `${DEMAND_WINDOW / 1000}秒`,
    });
  }

  scheduleRetry(main);
}

function scheduleSync(main: HTMLElement): void {
  if (pendingFrame) return;
  pendingFrame = window.requestAnimationFrame(() => {
    pendingFrame = 0;
    syncNativeProgress(main);
  });
}

function scheduleRetry(main: HTMLElement): void {
  window.clearTimeout(retryTimer);
  retryTimer = 0;
  if (Date.now() >= demandUntil || !main.isConnected || !isNearBottom(main)) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    cachedScroller = null;
    scheduleSync(main);
  }, RETRY_DELAY);
}

function requestSync(main: HTMLElement, keepDemand = false): void {
  resetForReaderUrl();
  if (isNearBottom(main) && keepDemand) demandUntil = Date.now() + DEMAND_WINDOW;
  else if (!isNearBottom(main)) demandUntil = 0;
  scheduleSync(main);
}

export function bindReaderProgressiveLoad(main: HTMLElement): void {
  if (main.dataset.wrfProgressiveLoadBound === '1') return;
  main.dataset.wrfProgressiveLoadBound = '1';

  main.addEventListener('scroll', () => {
    requestSync(main, isNearBottom(main));
  }, { passive: true });

  main.addEventListener('wheel', (event) => {
    if (event.deltaY > 0) requestSync(main, true);
  }, { passive: true });

  main.addEventListener('touchmove', () => {
    requestSync(main, true);
  }, { passive: true });

  scheduleSync(main);
}
