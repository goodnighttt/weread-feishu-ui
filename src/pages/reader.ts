import { getReaderMeta } from '../adapter/weread';
import { state } from '../core/state';
import { syncNativeTocHitTargets, clearNativeTocHitTargets } from '../reader/chapter-navigation';
import { getReaderBlocks, readerBlocksHtml } from '../reader/content';
import {
  ensureActiveTocAncestorsExpanded,
  findActiveTocIndex,
  getReaderCollapsedTocSet,
  primeReaderToc,
  scheduleReaderTocPrimeRetry,
  scrollReaderTocToActive,
} from '../reader/toc';
import { readerViewHtml } from '../ui/reader-view';
import { setShellHtml } from '../ui/shell';

export function renderReader(version: string): void {
  clearNativeTocHitTargets();
  const meta = getReaderMeta();
  const blocks = getReaderBlocks();
  if (state.readerTocItems.length) ensureActiveTocAncestorsExpanded(state.readerTocItems, meta);
  const activeIndex = findActiveTocIndex(state.readerTocItems, meta);
  setShellHtml(readerViewHtml({
    meta,
    blocks,
    tocItems: state.readerTocItems,
    tocOpen: state.readerTocOpen,
    collapsed: getReaderCollapsedTocSet(),
    activeIndex,
    pinnedBooks: state.pinnedBooks,
    version,
  }));
  // Keep the original WeRead rows as transparent hit targets so clicks retain
  // the browser's trusted event and Vue performs the real navigation.
  queueMicrotask(() => { syncNativeTocHitTargets(); });
  if (state.readerTocOpen) {
    queueMicrotask(() => {
      if (!state.readerTocItems.length) {
        void primeReaderToc(() => renderReader(version));
        scheduleReaderTocPrimeRetry(() => renderReader(version));
      } else {
        scrollReaderTocToActive();
      }
    });
  }
}

export function refreshReaderMeta(version: string): void {
  if (!state.root || state.page !== 'reader') return;
  const meta = getReaderMeta();
  const parts = state.root.querySelectorAll('.wrf-breadcrumb .strong');
  if (parts[0] && parts[0].textContent !== meta.book) parts[0].textContent = meta.book;
  if (parts[1] && parts[1].textContent !== meta.chapter) parts[1].textContent = meta.chapter;
  const title = state.root.querySelector('.wrf-article-title');
  if (title && title.textContent !== meta.chapter) title.textContent = meta.chapter;

  if (!state.readerTocItems.length) return;
  if (ensureActiveTocAncestorsExpanded(state.readerTocItems, meta)) {
    renderReader(version);
    return;
  }
  const activeIndex = findActiveTocIndex(state.readerTocItems, meta);
  const previousActive = state.root.querySelector('.wrf-outline-row.active')?.getAttribute('data-toc-index');
  state.root.querySelectorAll('.wrf-outline-row').forEach((row) => {
    row.classList.toggle('active', Number(row.getAttribute('data-toc-index')) === activeIndex);
  });
  if (previousActive !== String(activeIndex)) scrollReaderTocToActive();
  syncNativeTocHitTargets();
}

export function refreshReaderArticle(): void {
  if (!state.enabled || !state.root || state.page !== 'reader') return;
  const body = state.root.querySelector('[data-reader-body]');
  if (!(body instanceof HTMLElement)) return;
  const blocks = getReaderBlocks();
  const signature = blocks.map((block) => `${block.type}:${block.text}`).join('|');
  if (!signature || signature === state.readerArticleSignature) return;
  state.readerArticleSignature = signature;
  const main = state.root.querySelector('[data-reader-main]');
  const scrollTop = main instanceof HTMLElement ? main.scrollTop : 0;
  body.innerHTML = readerBlocksHtml(blocks);
  if (main instanceof HTMLElement) main.scrollTop = scrollTop;
}
