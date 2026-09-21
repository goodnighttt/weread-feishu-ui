import { clickNative, clickNativeHomeText } from './adapter/weread';
import { cleanText, queryByText } from './core/dom';
import { detectPage, patchHistory } from './core/route';
import { state } from './core/state';
import { STORAGE, writeBoolean } from './core/storage';
import { clearCanvasCapture } from './reader/canvas-capture';
import { navigateToReaderTocItem } from './reader/chapter-navigation';
import {
  getReaderTocStorageKey,
  primeReaderToc,
  scrollReaderTocToActive,
  setReaderTocOpen,
  toggleReaderTocGroup,
} from './reader/toc';
import { enrichAndRefreshHome, refreshHome, renderHome } from './pages/home';
import { refreshReaderArticle, refreshReaderMeta, renderReader } from './pages/reader';
import { nativeReturnViewHtml } from './ui/reader-view';
import { ensureHost, hideHost, setShellHtml, showHost, toast } from './ui/shell';

let uiEventsBound = false;

function triggerHomeSearch(): void {
  if (state.page === 'home' && state.root) {
    state.root.querySelector('[data-searchbar]')?.classList.add('open');
    const input = state.root.querySelector('[data-search-input]');
    if (input instanceof HTMLInputElement) queueMicrotask(() => input.focus());
    return;
  }
  location.href = 'https://weread.qq.com/';
}

function submitHomeSearch(keyword: string): void {
  const value = cleanText(keyword);
  if (value) location.href = `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(value)}`;
}

async function shareCurrentPage(): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('已复制当前页面链接');
  } catch {
    const area = document.createElement('textarea');
    area.value = location.href;
    area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); toast('已复制当前页面链接'); }
    catch { toast('复制失败，请手动复制地址栏链接。'); }
    area.remove();
  }
}

function afterRender(version: string): void {
  if (!state.root || state.page !== 'reader' || !state.enabled) return;
  const readerMain = state.root.querySelector('[data-reader-main]');
  if (!(readerMain instanceof HTMLElement) || readerMain.dataset.wrfScrollBound === '1') return;
  readerMain.dataset.wrfScrollBound = '1';
  let syncing = false;
  readerMain.addEventListener('scroll', () => {
    if (syncing) return;
    syncing = true;
    requestAnimationFrame(() => {
      const overlayMax = Math.max(1, readerMain.scrollHeight - readerMain.clientHeight);
      const nativeMax = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      if (nativeMax > 0) window.scrollTo(0, (readerMain.scrollTop / overlayMax) * nativeMax);
      syncing = false;
    });
  }, { passive: true });
  // Keep active TOC visible after the new reader DOM is mounted.
  if (state.readerTocOpen) scrollReaderTocToActive();
  void version;
}

function bindUiEvents(version: string): void {
  if (uiEventsBound) return;
  const root = ensureHost();
  uiEventsBound = true;

  root.addEventListener('click', (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    switch (action) {
      case 'home': location.href = 'https://weread.qq.com/'; break;
      case 'shelf': location.href = 'https://weread.qq.com/web/shelf'; break;
      case 'search': triggerHomeSearch(); break;
      case 'note': if (!clickNative('note')) toast('没有找到微信读书原生笔记按钮'); break;
      case 'font': if (!clickNative('font')) toast('没有找到微信读书原生阅读设置'); break;
      case 'open-book': if (target.dataset.href) location.href = target.dataset.href; break;
      case 'upload': if (!clickNativeHomeText(['传书到手机', '上传'])) location.href = 'https://weread.qq.com/web/shelf'; break;
      case 'recent': state.root?.querySelector('.wrf-home-main')?.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'rank': {
        const native = queryByText(['a', 'button', '[role="button"]'], ['榜单']);
        if (native instanceof HTMLElement) native.click(); else toast('当前页面没有可打开的榜单入口');
        break;
      }
      case 'share': void shareCurrentPage(); break;
      case 'toggle-native': setEnabled(false, version); break;
      case 'return-feishu': setEnabled(true, version); break;
      case 'more': state.root?.querySelector('[data-more-menu]')?.classList.toggle('open'); break;
      case 'toc-toggle': {
        setReaderTocOpen(!state.readerTocOpen);
        renderReader(version);
        afterRender(version);
        if (state.readerTocOpen && !state.readerTocItems.length) void primeReaderToc(() => { renderReader(version); afterRender(version); });
        break;
      }
      case 'toc-fold': {
        const index = Number(target.dataset.tocIndex);
        if (Number.isInteger(index)) {
          toggleReaderTocGroup(index);
          renderReader(version);
          afterRender(version);
        }
        break;
      }
      case 'toc-item': {
        const index = Number(target.dataset.tocIndex);
        const title = cleanText(target.textContent || '');
        if (!Number.isInteger(index)) return;
        void navigateToReaderTocItem(index, title).then((ok) => {
          if (!ok) toast(`暂时无法跳转到「${title}」`);
        });
        break;
      }
    }
  });

  root.addEventListener('keydown', (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const input = keyboardEvent.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-search-input]')) return;
    if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      submitHomeSearch(input.value);
    } else if (keyboardEvent.key === 'Escape') {
      state.root?.querySelector('[data-searchbar]')?.classList.remove('open');
    }
  });
}

export function renderCurrentPage(version: string, force = false): void {
  if (state.page === 'none') {
    hideHost();
    return;
  }
  showHost();
  if (!state.enabled) {
    state.shellMarker = `native:${state.page}:${location.pathname}`;
    setShellHtml(nativeReturnViewHtml());
    return;
  }

  const marker = `feishu:${state.page}:${location.pathname}`;
  if (!force && state.shellMarker === marker) {
    if (state.page === 'reader') {
      refreshReaderMeta(version);
      refreshReaderArticle();
    }
    return;
  }
  state.shellMarker = marker;

  if (state.page === 'home') {
    const books = renderHome(version);
    void enrichAndRefreshHome(version, books).then((changed) => {
      if (changed) afterRender(version);
    });
  } else {
    renderReader(version);
  }
  bindUiEvents(version);
  afterRender(version);
}

export function applyPageState(version: string, force = false): void {
  const nextPage = detectPage();
  const previousPage = state.page;
  const urlChanged = state.lastUrl !== location.href;
  const changed = previousPage !== nextPage || urlChanged;
  const nextReaderBookKey = nextPage === 'reader' ? getReaderTocStorageKey() : '';
  const readerBookChanged = Boolean(nextPage === 'reader' && state.readerBookKey && nextReaderBookKey && state.readerBookKey !== nextReaderBookKey);

  if (changed && nextPage === 'reader') {
    clearCanvasCapture();
    state.readerArticleSignature = '';
    state.readerTocPrimeAttempts = 0;
    if (previousPage !== 'reader' || readerBookChanged) {
      state.readerTocItems = [];
      state.readerOfficialToc = [];
      state.readerOfficialTocPromise = null;
    }
    state.readerBookKey = nextReaderBookKey;
  } else if (nextPage !== 'reader') {
    state.readerBookKey = '';
  }

  state.page = nextPage;
  state.lastUrl = location.href;
  document.documentElement.classList.toggle('wrf-enabled', state.enabled && nextPage !== 'none');
  if (nextPage === 'none') document.documentElement.removeAttribute('data-wrf-page');
  else document.documentElement.setAttribute('data-wrf-page', nextPage);
  renderCurrentPage(version, force || changed);
}

export function setEnabled(enabled: boolean, version: string): void {
  state.enabled = enabled;
  writeBoolean(STORAGE.enabled, enabled);
  document.documentElement.classList.toggle('wrf-enabled', enabled && state.page !== 'none');
  renderCurrentPage(version, true);
  if (enabled) toast('已切换到飞书云文档外观');
}

export function startRouter(version: string): void {
  ensureHost();
  bindUiEvents(version);
  patchHistory(() => applyPageState(version, true));
  window.addEventListener('keydown', (event) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      setEnabled(!state.enabled, version);
    }
  }, true);

  state.observer?.disconnect();
  state.observer = new MutationObserver(() => {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      if (state.lastUrl !== location.href) {
        applyPageState(version, true);
        return;
      }
      if (!state.enabled) return;
      if (state.page === 'reader') {
        refreshReaderMeta(version);
        refreshReaderArticle();
      } else if (state.page === 'home') {
        const books = refreshHome(version);
        if (books) {
          bindUiEvents(version);
          void enrichAndRefreshHome(version, books);
        }
      }
    }, 140);
  });
  state.observer.observe(document.documentElement, { childList: true, subtree: true });
  applyPageState(version, true);
}
