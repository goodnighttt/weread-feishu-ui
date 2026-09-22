import { state } from '../core/state';

const LOAD_LOG = '[微信读书·飞书UI][正文续载]';
const BOTTOM_THRESHOLD = 240;
const LOAD_COOLDOWN = 500;
const MIN_NATIVE_STEP = 480;

let lastAdvanceAt = 0;
let lastReaderUrl = '';
let loggedReaderUrl = '';
let pendingFrame = 0;

function syncReaderUrl(): void {
  if (lastReaderUrl === location.href) return;
  lastReaderUrl = location.href;
  lastAdvanceAt = 0;
  loggedReaderUrl = '';
}

function isNearBottom(main: HTMLElement): boolean {
  return main.scrollHeight - main.clientHeight - main.scrollTop <= BOTTOM_THRESHOLD;
}

function advanceNativeReader(main: HTMLElement): void {
  syncReaderUrl();
  if (!state.enabled || state.page !== 'reader' || !isNearBottom(main)) return;

  const now = Date.now();
  if (now - lastAdvanceAt < LOAD_COOLDOWN) return;

  const scrolling = document.scrollingElement || document.documentElement;
  const nativeMax = Math.max(0, scrolling.scrollHeight - window.innerHeight);
  const nativeTop = Math.max(window.scrollY, scrolling.scrollTop || 0);
  if (nativeMax <= nativeTop + 4) return;

  const step = Math.max(MIN_NATIVE_STEP, Math.round(window.innerHeight * 0.8));
  const target = Math.min(nativeMax, nativeTop + step);
  lastAdvanceAt = now;
  window.scrollTo({ left: window.scrollX, top: target, behavior: 'auto' });

  if (loggedReaderUrl !== lastReaderUrl) {
    loggedReaderUrl = lastReaderUrl;
    console.info(`${LOAD_LOG} 已启用按需续载`, {
      '触发距离': `${BOTTOM_THRESHOLD}px`,
      '单次推进': `${step}px`,
    });
  }
}

function scheduleNativeAdvance(main: HTMLElement): void {
  if (pendingFrame) return;
  pendingFrame = window.requestAnimationFrame(() => {
    pendingFrame = 0;
    advanceNativeReader(main);
  });
}

export function bindReaderProgressiveLoad(main: HTMLElement): void {
  if (main.dataset.wrfProgressiveLoadBound === '1') return;
  main.dataset.wrfProgressiveLoadBound = '1';

  main.addEventListener('scroll', () => {
    scheduleNativeAdvance(main);
  }, { passive: true });

  // 当飞书正文已经滚到底时，scrollTop 不再变化；继续向下滚轮仍应能推进原生阅读器。
  main.addEventListener('wheel', (event) => {
    if (event.deltaY > 0) scheduleNativeAdvance(main);
  }, { passive: true });
}
