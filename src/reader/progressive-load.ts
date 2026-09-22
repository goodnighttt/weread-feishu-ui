import { state } from '../core/state';

const LOAD_LOG = '[微信读书·飞书UI][正文续载]';
const BOTTOM_THRESHOLD = 240;
const LOAD_COOLDOWN = 450;
const RETRY_DELAY = 650;
const DEMAND_WINDOW = 6000;
const MIN_NATIVE_STEP = 480;

let lastAdvanceAt = 0;
let lastReaderUrl = '';
let loggedReaderUrl = '';
let pendingFrame = 0;
let retryTimer = 0;
let demandUntil = 0;

function resetForReaderUrl(): void {
  if (lastReaderUrl === location.href) return;
  lastReaderUrl = location.href;
  lastAdvanceAt = 0;
  loggedReaderUrl = '';
  demandUntil = 0;
  window.clearTimeout(retryTimer);
  retryTimer = 0;
}

function isNearBottom(main: HTMLElement): boolean {
  return main.scrollHeight - main.clientHeight - main.scrollTop <= BOTTOM_THRESHOLD;
}

function scheduleRetry(main: HTMLElement): void {
  window.clearTimeout(retryTimer);
  retryTimer = 0;
  if (Date.now() >= demandUntil || !main.isConnected || !isNearBottom(main)) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    scheduleNativeAdvance(main);
  }, RETRY_DELAY);
}

function advanceNativeReader(main: HTMLElement): void {
  resetForReaderUrl();
  if (!state.enabled || state.page !== 'reader' || !main.isConnected || !isNearBottom(main)) return;
  if (Date.now() >= demandUntil) return;

  const now = Date.now();
  if (now - lastAdvanceAt < LOAD_COOLDOWN) {
    scheduleRetry(main);
    return;
  }

  const scrolling = document.scrollingElement || document.documentElement;
  const nativeMax = Math.max(0, scrolling.scrollHeight - window.innerHeight);
  const nativeTop = Math.max(window.scrollY, scrolling.scrollTop || 0);

  if (nativeMax > nativeTop + 4) {
    const step = Math.max(MIN_NATIVE_STEP, Math.round(window.innerHeight * 0.8));
    const target = Math.min(nativeMax, nativeTop + step);
    lastAdvanceAt = now;
    window.scrollTo({ left: window.scrollX, top: target, behavior: 'auto' });

    if (loggedReaderUrl !== lastReaderUrl) {
      loggedReaderUrl = lastReaderUrl;
      console.info(`${LOAD_LOG} 已启用按需续载`, {
        '触发距离': `${BOTTOM_THRESHOLD}px`,
        '单次推进': `${step}px`,
        '异步重试': `${DEMAND_WINDOW / 1000}秒`,
      });
    }
  }

  // 微信读书会在滚动后异步扩展原生页面高度。即使本次已经到达当前底部，
  // 也在用户刚刚明确要求“继续往下读”的短时间窗口内继续检查。
  scheduleRetry(main);
}

function scheduleNativeAdvance(main: HTMLElement): void {
  if (pendingFrame) return;
  pendingFrame = window.requestAnimationFrame(() => {
    pendingFrame = 0;
    advanceNativeReader(main);
  });
}

function requestMoreContent(main: HTMLElement): void {
  resetForReaderUrl();
  if (!isNearBottom(main)) return;
  demandUntil = Date.now() + DEMAND_WINDOW;
  scheduleNativeAdvance(main);
}

export function bindReaderProgressiveLoad(main: HTMLElement): void {
  if (main.dataset.wrfProgressiveLoadBound === '1') return;
  main.dataset.wrfProgressiveLoadBound = '1';

  main.addEventListener('scroll', () => {
    requestMoreContent(main);
  }, { passive: true });

  // 飞书正文已经到底后 scrollTop 不再变化，因此继续向下滚轮也要视为“继续读”。
  main.addEventListener('wheel', (event) => {
    if (event.deltaY > 0) requestMoreContent(main);
  }, { passive: true });

  main.addEventListener('touchmove', () => {
    requestMoreContent(main);
  }, { passive: true });
}
