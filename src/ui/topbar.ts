import { escapeHtml } from '../core/dom';
import type { ReaderMeta } from '../core/types';
import { icon } from './icons';

export function homeTopbarHtml(): string {
  return `
    <header class="wrf-topbar">
      <div class="wrf-breadcrumb"><span class="wrf-home-title">主页</span></div>
      <div class="wrf-top-actions">
        <button class="wrf-btn wrf-icon-btn" data-action="search" title="搜索">${icon('search', 17)}</button>
        <button class="wrf-btn wrf-icon-btn" data-action="share" title="复制页面链接">${icon('share', 17)}</button>
        <button class="wrf-btn wrf-icon-btn" data-action="more" title="更多">${icon('dots', 18)}</button>
      </div>
    </header>`;
}

export function readerTopbarHtml(meta: ReaderMeta): string {
  return `
    <header class="wrf-topbar">
      <div class="wrf-breadcrumb">
        <span class="strong">${escapeHtml(meta.book)}</span>${icon('chevron', 13)}
        <span class="strong" style="font-weight:400;color:#646a73">${escapeHtml(meta.chapter)}</span>
      </div>
      <div class="wrf-top-actions">
        <button class="wrf-btn primary" data-action="share">${icon('share', 15)}<span>分享</span></button>
        <button class="wrf-btn">${icon('edit', 15)}<span>编辑⌄</span></button>
        <button class="wrf-btn wrf-icon-btn" data-action="note" title="通知 / 笔记">${icon('bell', 17)}</button>
        <button class="wrf-btn wrf-icon-btn" data-action="more" title="更多">${icon('dots', 18)}</button>
        <span class="wrf-top-divider"></span>
        <button class="wrf-btn wrf-icon-btn" data-action="search" title="搜索">${icon('search', 17)}</button>
        <button class="wrf-btn wrf-icon-btn" title="新建">${icon('plus', 18)}</button>
        <span class="wrf-avatar-dot">阅</span>
      </div>
    </header>`;
}

export function moreMenuHtml(): string {
  return `
    <div class="wrf-more-menu" data-more-menu>
      <button class="wrf-more-item" data-action="note">笔记</button>
      <button class="wrf-more-item" data-action="font">阅读设置</button>
      <button class="wrf-more-item" data-action="toggle-native">切回微信读书原界面 <span class="wrf-more-shortcut">Alt+F</span></button>
    </div>`;
}
