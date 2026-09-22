import { state } from '../core/state';

const LOAD_LOG = '[微信读书·飞书UI][正文续载]';
const BOTTOM_THRESHOLD = 240;
const RETRY_DELAY = 600;
const DEMAND_WINDOW = 6000;

let lastReaderUrl = '';
let loggedReaderUrl = '';
let pendingFrame = 0;
let retryTimer = 0;
let demandUntil = 0;
let markedScroller: HTMLElement | null = null;

type NativeScroller = {
  element: HTMLElement;
  isDocument: boolean;
  label: string;
};

function resetForReaderUrl(): void {
  if (lastReaderUrl === location.href) return;
  lastReaderUrl = location.href;
  loggedReaderUrl = '';
  demandUntil = 0;
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
    ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join('')
    : '';
  return `${element.tagName.toLowerCase()}${id}${className}`;
}

function findNativeScroller(): NativeScroller {
  const scrollingElement = (document.scrollingElement || document.documentElement) as HTMLElement;
  const content = document.querySelector<HTMLElement>('.readerChapterContent')
    || document.querySelector<HTMLElement>('.readerContent');

  let current = content;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = getComputedStyle(current);
    const overflowY = style.overflowY || style.overflow;
    const canScroll = /auto|scroll|overlay/i.test(overflowY)
      && current.scrollHeight > current.clientHeight + 8;
    if (canScroll) {
      return { element: current, isDocument: false, label: describeElement(current) };
    }
    current = current.parentElement;
  }

  return {
    element: scrollingElement,
    isDocument: true,
    label: describeElement(scrollingElement),
  };
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
  if (metrics.max <= 0) {
    scheduleRetry(main);
    return;
  }

  const target = progress >= 0.995 ? metrics.max : Math.round(metrics.max * progress);
  if (Math.abs(target - metrics.top) > 2) setNativeScroll(scroller, target);

  if (loggedReaderUrl !== lastReaderUrl) {
    loggedReaderUrl = lastReaderUrl;
    console.info(`${LOAD_LOG} 已同步原生阅读进度`, {
      '原生滚动容器': scroller.label,
      '飞书进度': `${Math.round(progress * 100)}%`,
      '原生滚动范围': `${metrics.max}px`,
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

  // 到底后 scrollTop 不再变化；继续向下滚轮时，把原生阅读器再次同步到“新的底部”。
  main.addEventListener('wheel', (event) => {
    if (event.deltaY > 0) requestSync(main, true);
  }, { passive: true });

  main.addEventListener('touchmove', () => {
    requestSync(main, true);
  }, { passive: true });

  // 初次绑定也同步一次，避免飞书与原生阅读进度从一开始就错位。
  scheduleSync(main);
}
