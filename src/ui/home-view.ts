import { escapeHtml } from '../core/dom';
import type { BookEntry } from '../core/types';
import { icon } from './icons';
import { sidebarHtml } from './sidebar';
import { homeTopbarHtml, moreMenuHtml } from './topbar';

function initials(text = ''): string {
  return text.trim().slice(0, 1).toUpperCase() || '文';
}

function homeRowsHtml(books: BookEntry[]): string {
  if (!books.length) return '<tr><td colspan="6"><div class="wrf-empty">正在读取微信读书首页内容…</div></td></tr>';
  return books.map((book, index) => `
    <tr class="wrf-doc-row" data-action="open-book" data-href="${escapeHtml(book.href)}">
      <td><div class="wrf-doc-title-cell"><span class="wrf-file-icon"></span><span class="wrf-doc-title">${escapeHtml(book.title)}</span></div></td>
      <td><span class="wrf-doc-location">${icon('shelf', 14)} ${escapeHtml(book.category || '其他')}</span></td>
      <td><span class="wrf-avatar">${escapeHtml(initials(book.author))}</span>${escapeHtml(book.author)}</td>
      <td>${index < 4 ? '今天' : '最近'}</td>
      <td>${index === 0 ? '刚刚' : `${Math.min(index + 1, 9)} 小时前`}</td>
      <td style="text-align:right;color:#8f959e">${icon('dots', 16)}</td>
    </tr>`).join('');
}

export function homeViewHtml(books: BookEntry[], pinnedBooks: BookEntry[], version: string): string {
  return `
    <div class="wrf-shell">
      ${sidebarHtml('home', pinnedBooks.length ? pinnedBooks : books, version)}
      ${homeTopbarHtml()}
      ${moreMenuHtml()}
      <div class="wrf-home-searchbar" data-searchbar>${icon('search', 17)}<input data-search-input type="text" placeholder="搜索文档、书籍" autocomplete="off" /></div>
      <main class="wrf-home-main">
        <div class="wrf-home-inner">
          <div class="wrf-quick-actions">
            <button class="wrf-quick-card" data-action="search"><span class="wrf-quick-icon">${icon('note', 19)}</span><span class="wrf-quick-copy"><span class="wrf-quick-title">新建</span><span class="wrf-quick-desc">搜索并打开一本书</span></span></button>
            <button class="wrf-quick-card" data-action="upload"><span class="wrf-quick-icon">${icon('shelf', 19)}</span><span class="wrf-quick-copy"><span class="wrf-quick-title">上传</span><span class="wrf-quick-desc">传书到手机或管理书架</span></span></button>
            <button class="wrf-quick-card" data-action="rank"><span class="wrf-quick-icon">${icon('rank', 19)}</span><span class="wrf-quick-copy"><span class="wrf-quick-title">模板库</span><span class="wrf-quick-desc">浏览微信读书榜单内容</span></span></button>
          </div>
          <div class="wrf-home-tabs"><button class="wrf-home-tab active">最近访问</button><button class="wrf-home-tab">归我所有</button><button class="wrf-home-tab">与我共享</button><button class="wrf-home-tab">收藏</button><button class="wrf-home-tab">＋</button></div>
          <div class="wrf-list-toolbar"><button class="wrf-ghost-action">筛选</button><button class="wrf-ghost-action">显示设置</button><button class="wrf-ghost-action">☰</button><button class="wrf-ghost-action">▦</button></div>
          <table class="wrf-doc-table"><colgroup><col style="width:36%"><col style="width:18%"><col style="width:16%"><col style="width:12%"><col style="width:14%"><col style="width:4%"></colgroup><thead><tr><th>标题</th><th>位置</th><th>所有者</th><th>创建时间</th><th>最近访问 ↓</th><th></th></tr></thead><tbody>${homeRowsHtml(books)}</tbody></table>
        </div>
      </main>
    </div>`;
}
