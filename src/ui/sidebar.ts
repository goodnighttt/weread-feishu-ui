import { canonicalBookTitle } from '../adapter/weread';
import { escapeHtml } from '../core/dom';
import type { BookEntry, PageKind } from '../core/types';
import { icon, larkLogo } from './icons';

function pinnedBooksHtml(books: BookEntry[]): string {
  const seen = new Set<string>();
  return books
    .filter((book) => book.category === '最近热搜' || book.category === '大家都在看')
    .filter((book) => {
      const key = canonicalBookTitle(book.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map((book) => `
      <button class="wrf-nav-item" data-action="open-book" data-href="${escapeHtml(book.href)}" title="${escapeHtml(book.title)}">
        ${icon('note')}<span>${escapeHtml(book.title)}</span>
      </button>`).join('');
}

export function sidebarHtml(page: PageKind, books: BookEntry[], version: string): string {
  const reader = page === 'reader';
  const pinned = pinnedBooksHtml(books);
  return `
    <aside class="wrf-sidebar">
      <div class="wrf-brand">${larkLogo()}<span>飞书云文档</span></div>
      <div class="wrf-search" data-action="search">${icon('search', 16)}<span>搜索</span></div>
      <nav class="wrf-nav">
        <button class="wrf-nav-item ${reader ? '' : 'active'}" data-action="home">${icon('home')}<span>主页</span></button>
        <button class="wrf-nav-item" data-action="shelf">${icon('shelf')}<span>云盘</span></button>
        ${reader ? `<button class="wrf-nav-item active" data-action="toc-toggle">${icon('catalog')}<span>目录</span></button>` : ''}
        ${reader ? `<button class="wrf-nav-item" data-action="note">${icon('note')}<span>知识库</span></button>` : `<button class="wrf-nav-item" data-action="recent">${icon('recent')}<span>知识库</span></button>`}
        ${reader ? '' : `<button class="wrf-nav-item" data-action="rank">${icon('rank')}<span>智能纪要</span></button>`}
      </nav>
      <div class="wrf-section-title">置顶文档</div>
      <nav class="wrf-nav">${pinned || '<div class="wrf-version">暂无置顶文档</div>'}</nav>
      <div class="wrf-spacer"></div>
      <div class="wrf-version">WeRead Feishu UI · v${version}</div>
    </aside>`;
}
