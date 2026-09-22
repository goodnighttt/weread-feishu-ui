import { escapeHtml } from '../core/dom';
import type { BookEntry, ReaderBlock, ReaderMeta, TocItem } from '../core/types';
import { hasTocChildren, tocItemStableKey } from '../reader/toc';
import { readerBlocksHtml } from '../reader/content';
import { icon } from './icons';
import { sidebarHtml } from './sidebar';
import { moreMenuHtml, readerTopbarHtml } from './topbar';

function outlineHtml(
  meta: ReaderMeta,
  items: TocItem[],
  open: boolean,
  collapsed: Set<string>,
  activeIndex: number,
): string {
  if (!items.length) {
    return `<aside class="wrf-reader-outline ${open ? '' : 'hidden'}"><div class="wrf-outline-title">目录</div><div class="wrf-outline-empty">正在读取目录…</div></aside>`;
  }

  const collapsedAncestors: Array<{ level: number; index: number }> = [];
  const rows: string[] = [];
  items.forEach((item, index) => {
    const level = Math.max(0, Math.min(4, Number(item.level) || 0));
    while (collapsedAncestors.length && level <= collapsedAncestors[collapsedAncestors.length - 1].level) collapsedAncestors.pop();
    const hiddenByAncestor = collapsedAncestors.length > 0;
    const hasChildren = hasTocChildren(items, index);
    const key = tocItemStableKey(item, index);
    const isCollapsed = hasChildren && collapsed.has(key);
    const locked = Boolean(item.locked);
    if (!hiddenByAncestor) {
      const fold = hasChildren
        ? `<button class="wrf-outline-fold ${isCollapsed ? 'collapsed' : ''}" data-action="toc-fold" data-toc-index="${index}" aria-label="${isCollapsed ? '展开' : '收起'} ${escapeHtml(item.title)}">${icon('chevron', 13)}</button>`
        : `<span class="wrf-outline-fold placeholder">${icon('chevron', 13)}</span>`;
      const itemTitle = locked ? `${item.title}（已锁定）` : item.title;
      rows.push(`
        <div class="wrf-outline-row ${index === activeIndex ? 'active' : ''} ${locked ? 'locked' : ''}" data-toc-index="${index}" data-level="${level}" style="--wrf-toc-level:${level}">
          ${fold}<button class="wrf-outline-item" data-action="toc-item" data-toc-index="${index}" title="${escapeHtml(itemTitle)}" ${locked ? 'disabled aria-disabled="true"' : ''}>${escapeHtml(item.title)}</button>${locked ? `<span class="wrf-outline-lock" title="该章节在微信读书中处于锁定状态">${icon('lock', 13)}</span>` : ''}
        </div>`);
    }
    if (isCollapsed) collapsedAncestors.push({ level, index });
  });
  return `<aside class="wrf-reader-outline ${open ? '' : 'hidden'}"><div class="wrf-outline-title">目录</div>${rows.join('')}</aside>`;
}

export function readerViewHtml(args: {
  meta: ReaderMeta;
  blocks: ReaderBlock[];
  tocItems: TocItem[];
  tocOpen: boolean;
  collapsed: Set<string>;
  activeIndex: number;
  pinnedBooks: BookEntry[];
  version: string;
}): string {
  const { meta, blocks, tocItems, tocOpen, collapsed, activeIndex, pinnedBooks, version } = args;
  const tooltip = tocOpen ? '收起目录' : '展开目录';
  return `
    <div class="wrf-shell wrf-reader-shell">
      ${sidebarHtml('reader', pinnedBooks, version)}
      ${readerTopbarHtml(meta)}
      ${moreMenuHtml()}
      ${outlineHtml(meta, tocItems, tocOpen, collapsed, activeIndex)}
      <button class="wrf-toc-toggle ${tocOpen ? 'open' : ''}" data-action="toc-toggle" data-tooltip="${tooltip}" aria-label="${tooltip}">${icon('catalog', 18)}</button>
      <main class="wrf-reader-main ${tocOpen ? 'with-outline' : ''}" data-reader-main>
        <article class="wrf-article">
          <h1 class="wrf-article-title">${escapeHtml(meta.chapter)}</h1>
          <div class="wrf-article-meta"><span>${escapeHtml(meta.author)}</span><span>·</span><span>${escapeHtml(meta.book)}</span></div>
          <div class="wrf-article-divider"></div>
          <div class="wrf-article-body" data-reader-body>${readerBlocksHtml(blocks)}</div>
        </article>
      </main>
    </div>`;
}

export function nativeReturnViewHtml(): string {
  return '<div class="wrf-shell"><button class="wrf-native-return" data-action="return-feishu" title="也可以按 Alt+F">返回飞书模式</button></div>';
}
