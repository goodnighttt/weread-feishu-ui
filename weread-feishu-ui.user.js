// ==UserScript==
// @name         [LEGACY 0.4.4] 微信读书 · 飞书云文档外观
// @namespace    https://weread.qq.com/
// @version      0.4.4
// @description  LEGACY 单文件备份。正式开发源码已迁移到 src/，请安装 dist/weread-feishu-ui.user.js。
// @author       local
// @match        https://weread.qq.com/*
// @icon         https://weread.qq.com/favicon.ico
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const APP_ID = 'wr-feishu-ui';
  const HOST_ID = `${APP_ID}-host`;
  const STYLE_ID = `${APP_ID}-global-style`;
  const STORAGE_ENABLED = `${APP_ID}:enabled`;
  const STORAGE_PINNED = `${APP_ID}:pinned-books`;
  const STORAGE_READER_TOC_OPEN = `${APP_ID}:reader-toc-open`;
  const STORAGE_READER_TOC_COLLAPSED = `${APP_ID}:reader-toc-collapsed`;
  const STORAGE_READER_TOC_MIGRATION = `${APP_ID}:reader-toc-v2`;
  const VERSION = '0.4.4';

  const state = {
    enabled: localStorage.getItem(STORAGE_ENABLED) !== '0',
    page: 'none',
    lastUrl: location.href,
    observer: null,
    refreshTimer: 0,
    host: null,
    root: null,
    shellMarker: '',
    homeDataSignature: '',
    readerTocOpen: (() => {
      // 0.4.4 起阅读页默认展开目录。迁移一次旧版本里可能遗留的关闭状态，
      // 后续用户主动收起后仍然尊重其选择。
      if (localStorage.getItem(STORAGE_READER_TOC_MIGRATION) !== '1') {
        localStorage.setItem(STORAGE_READER_TOC_MIGRATION, '1');
        localStorage.setItem(STORAGE_READER_TOC_OPEN, '1');
        return true;
      }
      return localStorage.getItem(STORAGE_READER_TOC_OPEN) !== '0';
    })(),
    readerTocItems: [],
    readerTocPrimeTimer: 0,
    readerTocPrimeAttempts: 0,
    readerBookKey: '',
    readerTocCollapsedByBook: (() => {
      try {
        const value = JSON.parse(localStorage.getItem(STORAGE_READER_TOC_COLLAPSED) || '{}');
        return value && typeof value === 'object' ? value : {};
      } catch {
        return {};
      }
    })(),
    readerOfficialToc: [],
    readerOfficialTocPromise: null,
    readerArticleSignature: '',
    metadataCache: new Map(),
    canvasCapture: new Map(),
    canvasRefreshTimer: 0,
    pinnedBooks: (() => {
      try { return JSON.parse(localStorage.getItem(STORAGE_PINNED) || '[]'); } catch { return []; }
    })(),
  };

  const PAGE = {
    HOME: 'home',
    READER: 'reader',
    NONE: 'none',
  };

  function scheduleCanvasRefresh() {
    window.clearTimeout(state.canvasRefreshTimer);
    state.canvasRefreshTimer = window.setTimeout(() => {
      if (state.enabled && state.page === PAGE.READER) refreshReaderArticle();
    }, 180);
  }

  function captureCanvasText(ctx, text, x, y) {
    if (!location.pathname.startsWith('/web/reader/')) return;
    const canvas = ctx?.canvas;
    if (!canvas || canvas.tagName !== 'CANVAS') return;
    const value = cleanText(text);
    if (!value || value.length > 800) return;

    let bucket = state.canvasCapture.get(canvas);
    if (!bucket) {
      bucket = { records: new Map(), updatedAt: 0 };
      state.canvasCapture.set(canvas, bucket);
    }

    const font = String(ctx.font || '16px sans-serif');
    let drawX = Number(x) || 0;
    let drawY = Number(y) || 0;
    let drawScale = 1;
    try {
      const matrix = ctx.getTransform();
      const originalX = drawX;
      const originalY = drawY;
      drawX = matrix.a * originalX + matrix.c * originalY + matrix.e;
      drawY = matrix.b * originalX + matrix.d * originalY + matrix.f;
      drawScale = Math.max(.01, Math.hypot(matrix.a, matrix.b));
    } catch {}
    const key = `${Math.round(drawX)}|${Math.round(drawY)}|${font}|${value}`;
    bucket.records.set(key, {
      text: value,
      x: drawX,
      y: drawY,
      font,
      scale: drawScale,
      align: String(ctx.textAlign || 'start'),
      width: (() => {
        try { return (ctx.measureText(value).width || 0) * drawScale; } catch { return 0; }
      })(),
    });
    bucket.updatedAt = Date.now();
    scheduleCanvasRefresh();
  }

  function installCanvasCapture() {
    const proto = pageWindow.CanvasRenderingContext2D?.prototype;
    if (!proto || proto.__wrfCaptureInstalled) return;
    proto.__wrfCaptureInstalled = true;
    const originalFillText = proto.fillText;
    proto.fillText = function (...args) {
      try { captureCanvasText(this, args[0], args[1], args[2]); } catch {}
      return originalFillText.apply(this, args);
    };
    if (typeof proto.strokeText === 'function') {
      const originalStrokeText = proto.strokeText;
      proto.strokeText = function (...args) {
        try { captureCanvasText(this, args[0], args[1], args[2]); } catch {}
        return originalStrokeText.apply(this, args);
      };
    }
  }

  installCanvasCapture();

  function detectPage() {
    const path = location.pathname;
    if (path.startsWith('/web/reader/')) return PAGE.READER;
    if (
      path === '/' ||
      path === '/web' ||
      path.startsWith('/web/shelf') ||
      path.startsWith('/web/search') ||
      path.startsWith('/web/category')
    ) return PAGE.HOME;
    return PAGE.NONE;
  }

  function escapeHtml(value = '') {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function icon(name, size = 18) {
    const attrs = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
    const paths = {
      home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
      shelf: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 5.5v16"/><path d="M8 7h8"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
      catalog: '<path d="M4 6h16M4 12h16M4 18h16"/>',
      note: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
      recent: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      rank: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
      menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
      share: '<circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 11 8-5M8 13l8 5"/>',
      dots: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
      chevron: '<path d="m9 6 6 6-6 6"/>',
      close: '<path d="m6 6 12 12M18 6 6 18"/>',
      eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>',
      bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    };
    return `<svg ${attrs}>${paths[name] || paths.menu}</svg>`;
  }

  function larkLogo() {
    return `
      <span class="wrf-logo" aria-hidden="true">
        <i class="wrf-logo-a"></i><i class="wrf-logo-b"></i><i class="wrf-logo-c"></i><i class="wrf-logo-d"></i>
      </span>`;
  }

  function ensureGlobalStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.wrf-enabled,
      html.wrf-enabled body {
        background: #ffffff !important;
      }

      html.wrf-enabled body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif !important;
      }

      /* ---------- 首页：原站仅作为数据源，视觉完全由飞书壳接管 ---------- */
      html.wrf-enabled[data-wrf-page="home"] body {
        overflow: hidden !important;
      }

      html.wrf-enabled[data-wrf-page="home"] #routerView,
      html.wrf-enabled[data-wrf-page="home"] .wr_header,
      html.wrf-enabled[data-wrf-page="home"] .wr_navBar,
      html.wrf-enabled[data-wrf-page="home"] .wr_index_page_header {
        display: none !important;
      }

      /* ---------- 阅读页：只保留正文渲染层，微信读书自己的外壳全部隐藏 ---------- */
      html.wrf-enabled[data-wrf-page="reader"] .readerTopBar {
        display: none !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] body {
        background: #fff !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerContent {
        box-sizing: border-box !important;
        margin-left: 0 !important;
        width: 100% !important;
        padding-top: 58px !important;
        background: #fff !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerContent .app_content,
      html.wrf-enabled[data-wrf-page="reader"] .app_content:not(#routerView) {
        box-sizing: border-box !important;
        opacity: 0 !important;
        pointer-events: none !important;
        user-select: none !important;
        max-width: 1040px !important;
        width: min(1040px, calc(100vw - 120px)) !important;
        margin-left: auto !important;
        margin-right: auto !important;
        padding-left: 72px !important;
        padding-right: 72px !important;
        background: #fff !important;
      }

      /* 飞书文档 / Markdown 风格正文排版 */
      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent,
      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent.navBarOffset {
        box-sizing: border-box !important;
        max-width: 760px !important;
        margin-left: auto !important;
        margin-right: auto !important;
        padding-top: 58px !important;
        padding-bottom: 120px !important;
        color: #1f2329 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
        font-size: 16px !important;
        line-height: 1.82 !important;
        letter-spacing: .01em !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent p {
        margin: 0 0 1.05em !important;
        color: #1f2329 !important;
        font-size: 16px !important;
        line-height: 1.82 !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent span {
        color: inherit !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent h1,
      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent [class*="chapterTitle"],
      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent [class*="_title"]:first-child {
        margin: 0 0 28px !important;
        color: #1f2329 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
        font-size: 32px !important;
        line-height: 1.34 !important;
        font-weight: 700 !important;
        letter-spacing: -.02em !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent h2 {
        margin: 36px 0 16px !important;
        color: #1f2329 !important;
        font-size: 24px !important;
        line-height: 1.4 !important;
        font-weight: 650 !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent h3 {
        margin: 30px 0 12px !important;
        color: #1f2329 !important;
        font-size: 19px !important;
        line-height: 1.45 !important;
        font-weight: 650 !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent blockquote {
        margin: 18px 0 !important;
        padding: 2px 0 2px 14px !important;
        border-left: 3px solid #c9cdd4 !important;
        color: #646a73 !important;
        background: transparent !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent pre {
        margin: 18px 0 !important;
        padding: 14px 16px !important;
        border: 1px solid #e5e6eb !important;
        border-radius: 6px !important;
        background: #f5f6f7 !important;
        color: #1f2329 !important;
        font: 14px/1.65 "SFMono-Regular", Consolas, "Liberation Mono", monospace !important;
        overflow: auto !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent code {
        padding: 2px 5px !important;
        border-radius: 4px !important;
        background: #f2f3f5 !important;
        color: #d44a3a !important;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent ul,
      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent ol {
        margin: 12px 0 18px !important;
        padding-left: 26px !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent li {
        margin: 5px 0 !important;
        line-height: 1.78 !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent table {
        width: 100% !important;
        margin: 20px 0 !important;
        border-collapse: collapse !important;
        font-size: 14px !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent th,
      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent td {
        padding: 9px 12px !important;
        border: 1px solid #dee1e6 !important;
        text-align: left !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent th {
        background: #f7f8fa !important;
        font-weight: 600 !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent a {
        color: #3370ff !important;
        text-decoration: none !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent hr {
        margin: 30px 0 !important;
        border: 0 !important;
        border-top: 1px solid #e5e6eb !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent .wr_canvasContainer,
      html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent .renderTargetContainer {
        margin-left: auto !important;
        margin-right: auto !important;
        background: #fff !important;
        box-shadow: none !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerControls {
        opacity: 0 !important;
        pointer-events: none !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerControls_item,
      html.wrf-enabled[data-wrf-page="reader"] .readerControls_fontSize {
        box-shadow: none !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerCatalog,
      html.wrf-enabled[data-wrf-page="reader"] .readerNotePanel {
        z-index: 999995 !important;
        top: 58px !important;
        bottom: 0 !important;
        border-radius: 0 !important;
        border: 0 !important;
        border-right: 1px solid #e5e6eb !important;
        box-shadow: 6px 0 24px rgba(31,35,41,.06) !important;
        background: #fff !important;
        color: #1f2329 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerNotePanel {
        z-index: 1000010 !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerCatalog {
        left: 0 !important;
        width: 300px !important;
        padding-top: 8px !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerCatalog [class*="title"] {
        color: #1f2329 !important;
        font-weight: 600 !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerCatalog [class*="item"],
      html.wrf-enabled[data-wrf-page="reader"] .readerCatalog a {
        border-radius: 6px !important;
        color: #4e5969 !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .readerCatalog [class*="active"],
      html.wrf-enabled[data-wrf-page="reader"] .readerCatalog [class*="selected"] {
        background: #eef3ff !important;
        color: #245bdb !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .wr_mask {
        z-index: 999991 !important;
      }

      html.wrf-enabled[data-wrf-page="reader"] .wr_whiteTheme,
      html.wrf-enabled[data-wrf-page="reader"] .wr_whiteTheme .readerContent,
      html.wrf-enabled[data-wrf-page="reader"] .wr_whiteTheme .app_content {
        background-color: #fff !important;
      }

      @media (max-width: 1100px) {
        html.wrf-enabled[data-wrf-page="reader"] .readerContent .app_content,
        html.wrf-enabled[data-wrf-page="reader"] .app_content:not(#routerView) {
          width: min(900px, calc(100vw - 48px)) !important;
          padding-left: 24px !important;
          padding-right: 24px !important;
        }

        html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent,
        html.wrf-enabled[data-wrf-page="reader"] .readerChapterContent.navBarOffset {
          max-width: 720px !important;
          padding-top: 42px !important;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureHost() {
    if (state.host?.isConnected) return state.host;
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'position:fixed;inset:0;z-index:1000000;pointer-events:none;';
      (document.body || document.documentElement).appendChild(host);
    }

    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    state.host = host;
    state.root = root;
    return host;
  }

  const shellCss = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button, input { font: inherit; }
    button { color: inherit; }

    .wrf-shell {
      --wrf-text: #1f2329;
      --wrf-muted: #8f959e;
      --wrf-line: #e5e6eb;
      --wrf-hover: #f2f3f5;
      --wrf-blue: #3370ff;
      --wrf-side: #f5f6f7;
      position: fixed;
      inset: 0;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--wrf-text);
    }

    .wrf-topbar {
      position: absolute;
      top: 0;
      left: 208px;
      right: 0;
      height: 58px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 22px;
      background: rgba(255,255,255,.96);
      border-bottom: 1px solid #eceef1;
      backdrop-filter: blur(12px);
      pointer-events: auto;
      z-index: 5;
    }

    .wrf-breadcrumb {
      min-width: 0;
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: #646a73;
    }

    .wrf-breadcrumb .strong {
      max-width: 460px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
      color: #1f2329;
    }

    .wrf-top-actions { display: flex; align-items: center; gap: 8px; }
    .wrf-top-divider { width:1px; height:22px; background:#e5e6eb; margin:0 2px; }
    .wrf-avatar-dot {
      width:30px; height:30px; border-radius:50%; background:#f2e2c8; color:#7a4c1d;
      display:grid; place-items:center; font-size:12px; font-weight:600;
    }
    .wrf-more-menu {
      position:absolute;
      right:18px;
      top:48px;
      width:210px;
      padding:6px;
      border:1px solid #e5e6eb;
      border-radius:8px;
      background:#fff;
      box-shadow:0 8px 28px rgba(31,35,41,.14);
      pointer-events:auto;
      display:none;
      z-index:20;
    }
    .wrf-more-menu.open { display:block; }
    .wrf-more-item {
      width:100%; height:34px; border:0; border-radius:6px; background:transparent; color:#4e5969;
      text-align:left; padding:0 10px; cursor:pointer; font-size:13px;
    }
    .wrf-more-item:hover { background:#f5f6f7; }
    .wrf-more-shortcut { float:right; color:#bbbfc4; font-size:11px; }

    .wrf-reader-shell .wrf-topbar {
      left: 208px;
    }

    .wrf-reader-shell .wrf-breadcrumb {
      padding-left: 0;
    }

    .wrf-btn {
      height: 32px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0 10px;
      cursor: pointer;
      font-size: 13px;
      color: #4e5969;
    }
    .wrf-btn:hover { background: var(--wrf-hover); }
    .wrf-btn.primary { background: var(--wrf-blue); color: white; padding-inline: 14px; }
    .wrf-btn.primary:hover { background: #2b62e7; }
    .wrf-icon-btn { width: 32px; padding: 0; border-radius: 50%; }

    .wrf-sidebar {
      position: absolute;
      inset: 0 auto 0 0;
      width: 208px;
      background: var(--wrf-side);
      border-right: 1px solid #ebecef;
      pointer-events: auto;
      padding: 12px 8px 18px;
      z-index: 6;
      display: flex;
      flex-direction: column;
    }

    .wrf-brand {
      height: 38px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 10px 8px;
      font-weight: 600;
      font-size: 15px;
      color: #1f2329;
      user-select: none;
    }

    .wrf-logo {
      width: 24px;
      height: 24px;
      position: relative;
      display: inline-block;
      flex: 0 0 auto;
    }
    .wrf-logo i { position:absolute; display:block; width:9px; height:9px; border-radius:3px; transform:rotate(12deg); }
    .wrf-logo-a { left:2px; top:2px; background:#2b74ff; }
    .wrf-logo-b { right:2px; top:2px; background:#20c2da; }
    .wrf-logo-c { left:2px; bottom:2px; background:#7b67ee; }
    .wrf-logo-d { right:2px; bottom:2px; background:#36cfc9; }

    .wrf-search {
      height: 34px;
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px 2px 12px;
      padding: 0 11px;
      background: #fff;
      color: #8f959e;
      border: 1px solid #e1e3e6;
      border-radius: 6px;
      cursor: text;
    }
    .wrf-search span { font-size: 13px; }

    .wrf-nav { display:flex; flex-direction:column; gap:2px; }
    .wrf-nav-item {
      width:100%;
      height:38px;
      border:0;
      border-radius:6px;
      background:transparent;
      padding:0 11px;
      display:flex;
      align-items:center;
      gap:10px;
      cursor:pointer;
      font-size:14px;
      color:#4e5969;
      text-align:left;
    }
    .wrf-nav-item:hover { background:#ebecef; }
    .wrf-nav-item.active { background:#e1e9ff; color:#245bdb; }
    .wrf-nav-item svg { flex:0 0 auto; }

    .wrf-section-title {
      padding: 20px 12px 8px;
      color:#8f959e;
      font-size:12px;
    }

    .wrf-spacer { flex: 1; }
    .wrf-version { color:#bbbfc4; font-size:11px; padding:8px 12px 0; }

    /* ---------- 飞书首页：不再露出微信读书原页面 ---------- */
    .wrf-home-main {
      position: absolute;
      top: 58px;
      left: 208px;
      right: 0;
      bottom: 0;
      overflow: auto;
      background: #fff;
      pointer-events: auto;
    }

    .wrf-home-inner {
      width: min(1180px, calc(100% - 64px));
      margin: 0 auto;
      padding: 28px 0 72px;
    }

    .wrf-quick-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      max-width: 760px;
      margin-bottom: 28px;
    }

    .wrf-quick-card {
      height: 76px;
      border: 1px solid #dee1e6;
      border-radius: 8px;
      background: #fff;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 18px;
      cursor: pointer;
      text-align: left;
      transition: background .14s ease, border-color .14s ease, box-shadow .14s ease;
    }
    .wrf-quick-card:hover {
      background: #fafbfc;
      border-color: #cfd3da;
      box-shadow: 0 3px 10px rgba(31,35,41,.05);
    }

    .wrf-quick-icon {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      background: #eef3ff;
      color: #3370ff;
    }
    .wrf-quick-card:nth-child(2) .wrf-quick-icon { background:#fff3e8; color:#ff8800; }
    .wrf-quick-card:nth-child(3) .wrf-quick-icon { background:#f3efff; color:#7b67ee; }

    .wrf-quick-copy { min-width: 0; }
    .wrf-quick-title { font-size: 14px; font-weight: 600; color:#1f2329; line-height:1.35; }
    .wrf-quick-desc { margin-top: 3px; font-size: 12px; color:#8f959e; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

    .wrf-home-tabs {
      height: 42px;
      display: flex;
      align-items: flex-end;
      gap: 28px;
      border-bottom: 1px solid #ebecef;
      margin-bottom: 10px;
    }

    .wrf-home-tab {
      position: relative;
      height: 42px;
      padding: 0 1px;
      border: 0;
      background: transparent;
      color:#646a73;
      font-size:14px;
      cursor:pointer;
    }
    .wrf-home-tab.active { color:#3370ff; font-weight:500; }
    .wrf-home-tab.active::after {
      content:"";
      position:absolute;
      left:0;
      right:0;
      bottom:-1px;
      height:2px;
      background:#3370ff;
      border-radius:2px;
    }

    .wrf-list-toolbar {
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      color:#646a73;
    }

    .wrf-ghost-action {
      height:30px;
      border:0;
      background:transparent;
      border-radius:6px;
      padding:0 9px;
      color:#646a73;
      cursor:pointer;
      display:inline-flex;
      align-items:center;
      gap:5px;
      font-size:12px;
    }
    .wrf-ghost-action:hover { background:#f2f3f5; }

    .wrf-doc-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    .wrf-doc-table th {
      height: 38px;
      border-bottom: 1px solid #ebecef;
      color:#8f959e;
      font-size:12px;
      font-weight:400;
      text-align:left;
      padding:0 12px;
    }

    .wrf-doc-table td {
      height: 52px;
      border-bottom: 1px solid #f0f1f2;
      color:#4e5969;
      font-size:13px;
      padding:0 12px;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }

    .wrf-doc-row { cursor:pointer; }
    .wrf-doc-row:hover td { background:#f7f8fa; }

    .wrf-doc-title-cell {
      display:flex;
      align-items:center;
      gap:10px;
      min-width:0;
      height:52px;
    }

    .wrf-file-icon {
      width: 20px;
      height: 24px;
      border-radius: 4px;
      background:#3370ff;
      flex:0 0 auto;
      position:relative;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.2);
    }
    .wrf-file-icon::before,
    .wrf-file-icon::after {
      content:"";
      position:absolute;
      left:5px;
      right:5px;
      height:1px;
      background:rgba(255,255,255,.85);
    }
    .wrf-file-icon::before { top:9px; }
    .wrf-file-icon::after { top:13px; }

    .wrf-doc-title {
      min-width:0;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      color:#1f2329;
      font-weight:500;
    }

    .wrf-doc-location {
      display:inline-flex;
      align-items:center;
      gap:5px;
      color:#8f959e;
    }

    .wrf-avatar {
      width:24px;
      height:24px;
      border-radius:50%;
      display:inline-grid;
      place-items:center;
      background:#eef3ff;
      color:#245bdb;
      font-size:11px;
      margin-right:7px;
      vertical-align:middle;
    }

    .wrf-empty {
      padding: 58px 20px;
      text-align:center;
      color:#8f959e;
      font-size:13px;
    }

    .wrf-home-searchbar {
      display:none;
      position:absolute;
      left:264px;
      top:12px;
      width:min(520px, calc(100vw - 620px));
      height:34px;
      z-index:9;
      pointer-events:auto;
    }
    .wrf-home-searchbar.open { display:block; }
    .wrf-home-searchbar input {
      width:100%;
      height:100%;
      border:1px solid #c9cdd4;
      outline:0;
      border-radius:7px;
      padding:0 12px 0 34px;
      color:#1f2329;
      background:#fff;
      box-shadow:0 4px 14px rgba(31,35,41,.08);
      font-size:13px;
    }
    .wrf-home-searchbar svg {
      position:absolute;
      left:10px;
      top:8px;
      color:#8f959e;
    }

    .wrf-toc-toggle {
      position: absolute;
      left: 216px;
      top: 74px;
      width: 34px;
      height: 34px;
      border: 0;
      border-radius: 7px;
      background: #fff;
      color: #3370ff;
      display: grid;
      place-items: center;
      cursor: pointer;
      pointer-events: auto;
      z-index: 8;
      box-shadow: 0 3px 12px rgba(31,35,41,.10);
    }
    .wrf-toc-toggle.open { left: 436px; }
    .wrf-toc-toggle:hover { background:#f5f7ff; }
    .wrf-toc-toggle::after {
      content: attr(data-tooltip);
      position: absolute;
      left: 0;
      top: -36px;
      padding: 7px 10px;
      border-radius: 6px;
      background: #1f2329;
      color: #fff;
      font-size: 12px;
      line-height: 1;
      white-space: nowrap;
      opacity: 0;
      transform: translateY(4px);
      pointer-events: none;
      transition: opacity .12s ease, transform .12s ease;
    }
    .wrf-toc-toggle:hover::after {
      opacity: 1;
      transform: translateY(0);
    }

    .wrf-reader-outline {
      position: absolute;
      top: 58px;
      left: 208px;
      bottom: 0;
      width: 220px;
      background: #fff;
      border-right: 1px solid #eceef1;
      pointer-events: auto;
      overflow: auto;
      z-index: 4;
      padding: 12px 8px 24px;
      transition: transform .16s ease, opacity .16s ease;
    }

    .wrf-reader-outline.hidden {
      transform: translateX(-100%);
      opacity: 0;
      pointer-events: none;
    }

    .wrf-outline-title {
      padding: 4px 10px 8px;
      color: #8f959e;
      font-size: 12px;
      font-weight: 500;
    }

    .wrf-outline-row {
      width: 100%;
      min-height: 31px;
      border-radius: 5px;
      display: flex;
      align-items: flex-start;
      padding-left: calc(6px + var(--wrf-toc-level, 0) * 16px);
      transition: background .12s ease;
    }
    .wrf-outline-row:hover { background:#f5f6f7; }
    .wrf-outline-row.active { background:#eef3ff; }

    .wrf-outline-fold {
      width: 18px;
      height: 31px;
      flex: 0 0 18px;
      border: 0;
      padding: 0;
      background: transparent;
      color: #8f959e;
      display: grid;
      place-items: center;
      cursor: pointer;
    }
    .wrf-outline-fold svg {
      width: 13px;
      height: 13px;
      transition: transform .14s ease;
      transform: rotate(90deg);
    }
    .wrf-outline-fold.collapsed svg { transform: rotate(0deg); }
    .wrf-outline-fold.placeholder { visibility: hidden; pointer-events: none; }
    .wrf-outline-fold:hover { color:#3370ff; }

    .wrf-outline-item {
      min-width: 0;
      flex: 1;
      min-height: 31px;
      border: 0;
      background: transparent;
      color: #646a73;
      display: block;
      padding: 6px 8px 5px 2px;
      text-align: left;
      cursor: pointer;
      font-size: 12px;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .wrf-outline-row[data-level="0"] .wrf-outline-item { color:#3f4752; font-weight: 600; }
    .wrf-outline-row[data-level="1"] .wrf-outline-item { color:#59636f; font-weight: 500; }
    .wrf-outline-row[data-level="2"] .wrf-outline-item,
    .wrf-outline-row[data-level="3"] .wrf-outline-item,
    .wrf-outline-row[data-level="4"] .wrf-outline-item { color:#7a838d; font-size:11.5px; }
    .wrf-outline-row.active .wrf-outline-item { color:#245bdb; font-weight: 600; }
    .wrf-outline-empty { padding: 14px 10px; color: #8f959e; font-size: 12px; line-height: 1.6; }

    .wrf-reader-main {
      position: absolute;
      top: 58px;
      left: 208px;
      right: 0;
      bottom: 0;
      overflow: auto;
      background: #fff;
      pointer-events: auto;
      z-index: 3;
      transition: left .16s ease;
    }

    .wrf-reader-main.with-outline { left: 428px; }

    .wrf-article {
      width: min(760px, calc(100% - 96px));
      margin: 0 auto;
      padding: 54px 0 160px;
      color: #1f2329;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    .wrf-article-title {
      margin: 0;
      color: #1f2329;
      font-size: 32px;
      line-height: 1.32;
      font-weight: 700;
      letter-spacing: -.02em;
    }

    .wrf-article-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 14px 0 24px;
      color: #8f959e;
      font-size: 12px;
    }

    .wrf-article-divider {
      height: 1px;
      background: #f0f1f2;
      margin: 0 0 28px;
    }

    .wrf-article-body {
      font-size: 16px;
      line-height: 1.78;
      color: #1f2329;
    }

    .wrf-md-p {
      margin: 0 0 13px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .wrf-md-h2 {
      margin: 34px 0 14px;
      font-size: 23px;
      line-height: 1.4;
      font-weight: 700;
      letter-spacing: -.01em;
    }

    .wrf-md-h3 {
      margin: 28px 0 12px;
      font-size: 18px;
      line-height: 1.45;
      font-weight: 650;
    }

    .wrf-md-quote {
      margin: 16px 0;
      padding: 2px 0 2px 13px;
      border-left: 3px solid #c9cdd4;
      color: #646a73;
    }

    .wrf-md-code {
      margin: 16px 0;
      padding: 14px 16px;
      border: 1px solid #e5e6eb;
      border-radius: 6px;
      background: #f5f6f7;
      color: #1f2329;
      font: 13px/1.65 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .wrf-article-loading {
      padding: 40px 0;
      color: #8f959e;
      font-size: 13px;
      line-height: 1.8;
    }

    .wrf-native-return {
      position: fixed;
      right: 18px;
      top: 14px;
      height: 34px;
      padding: 0 14px;
      border: 1px solid #d9dde3;
      border-radius: 7px;
      background: #fff;
      color: #245bdb;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 4px 16px rgba(31,35,41,.10);
      z-index: 99;
    }
    .wrf-native-return:hover { background:#f5f7ff; border-color:#b9c7f5; }

    .wrf-home-title {
      font-weight: 650;
      font-size: 18px;
      color:#1f2329;
    }

    @media (max-width: 1100px) {
      .wrf-sidebar { width:72px; align-items:center; padding-inline:7px; }
      .wrf-brand { padding:0 0 8px; justify-content:center; }
      .wrf-brand span:last-child, .wrf-search span, .wrf-nav-item span, .wrf-section-title, .wrf-version { display:none; }
      .wrf-search { width:42px; justify-content:center; padding:0; cursor:pointer; }
      .wrf-nav { width:100%; }
      .wrf-nav-item { justify-content:center; padding:0; }
      .wrf-topbar { left:72px; }
      .wrf-reader-shell .wrf-topbar { left:72px; }
      .wrf-reader-outline { left:72px; }
      .wrf-reader-main { left:72px; }
      .wrf-reader-main.with-outline { left:292px; }
      .wrf-toc-toggle { left:80px; }
      .wrf-toc-toggle.open { left:300px; }
      .wrf-home-main { left:72px; }
      .wrf-home-inner { width:min(calc(100% - 28px), 980px); }
      .wrf-quick-actions { grid-template-columns:1fr; max-width:none; }
      .wrf-home-searchbar { left:84px; width:calc(100vw - 190px); }
      .wrf-reader-tools { left:84px; }
    }
  `;

  function cleanText(value = '') {
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function normalizeUrl(value = '') {
    try {
      return new URL(value, location.origin).href;
    } catch {
      return '';
    }
  }

  const HOME_SECTION_NAMES = [
    '最近热搜', '大家都在看', '大家都在读', '热门推荐', '编辑推荐',
    '飙升榜', '新书榜', '总榜', '热搜榜', '榜单', '我的书架', '最近阅读',
  ];

  function normalizeSectionName(value = '') {
    const text = cleanText(value);
    if (!text || text.length > 32) return '';
    if (text.includes('最近热搜')) return '最近热搜';
    if (text.includes('大家都在看') || text.includes('大家都在读')) return '大家都在看';
    if (text.includes('飙升榜')) return '飙升榜';
    if (text.includes('新书榜')) return '新书榜';
    if (text.includes('热搜榜')) return '热搜榜';
    if (text === '总榜' || text.includes('总榜')) return '总榜';
    if (text === '榜单') return '榜单';
    if (text.includes('我的书架')) return '我的书架';
    if (text.includes('最近阅读')) return '最近阅读';
    if (text.includes('热门推荐')) return '热门推荐';
    if (text.includes('编辑推荐')) return '编辑推荐';
    return HOME_SECTION_NAMES.includes(text) ? text : '';
  }

  function collectHomeSectionMarkers() {
    const selectors = [
      'h1', 'h2', 'h3', 'h4', 'h5',
      '[class*="section"] [class*="title"]',
      '[class*="header"] [class*="title"]',
      '[class*="ranking"] [class*="title"]',
      '[class*="rank"] [class*="title"]',
      '[class*="title"]',
    ];
    const seen = new Set();
    const markers = [];
    for (const node of document.querySelectorAll(selectors.join(','))) {
      if (!(node instanceof Element) || seen.has(node)) continue;
      const name = normalizeSectionName(node.textContent || '');
      if (!name) continue;
      seen.add(node);
      markers.push({ node, name });
    }
    return markers;
  }

  function detectBookSection(anchor, markers) {
    let result = '';
    for (const marker of markers) {
      if (marker.node === anchor || marker.node.contains(anchor)) continue;
      const position = marker.node.compareDocumentPosition(anchor);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) result = marker.name;
    }
    if (result) return result;

    let cursor = anchor.parentElement;
    for (let depth = 0; depth < 7 && cursor && cursor !== document.body; depth += 1) {
      for (const child of cursor.children) {
        const name = normalizeSectionName(child.textContent || '');
        if (name) return name;
      }
      cursor = cursor.parentElement;
    }
    return '其他';
  }

  function getBookContainer(anchor) {
    let node = anchor;
    for (let i = 0; i < 5 && node?.parentElement; i += 1) {
      const parent = node.parentElement;
      const text = cleanText(parent.textContent || '');
      const images = parent.querySelectorAll('img').length;
      const bookLinks = parent.querySelectorAll('a[href*="/web/reader/"], a[href*="/web/bookDetail/"]').length;
      if (text.length > 0 && text.length < 220 && images <= 2 && bookLinks <= 2) node = parent;
      else break;
    }
    return node || anchor;
  }

  function pickText(root, selectors, reject = []) {
    if (!(root instanceof Element)) return '';
    for (const selector of selectors) {
      const nodes = root.matches(selector) ? [root] : [...root.querySelectorAll(selector)];
      for (const node of nodes) {
        const value = cleanText(node.textContent || node.getAttribute?.('title') || node.getAttribute?.('alt') || '');
        if (!value || value.length > 90) continue;
        if (reject.some((item) => value.includes(item))) continue;
        return value;
      }
    }
    return '';
  }

  function collectRecentHotSearchEntries(sectionMarkers, books) {
    const marker = sectionMarkers.find((item) => item.name === '最近热搜');
    if (!marker) return [];

    let scope = marker.node.parentElement;
    let candidates = [];
    for (let depth = 0; depth < 5 && scope; depth += 1) {
      candidates = [...scope.querySelectorAll('a, button, [role="button"]')]
        .map((node) => ({ node, title: cleanText(node.textContent || node.getAttribute?.('title') || '') }))
        .filter((item) => item.title && item.title !== '最近热搜' && item.title.length >= 2 && item.title.length <= 30)
        .filter((item) => !['搜索', '换一批', '登录', '传书到手机', '大家都在看', '大家都在读', '榜单', '飙升榜', '新书榜'].some((word) => item.title.includes(word)));
      if (candidates.length >= 2 && candidates.length <= 12) break;
      scope = scope.parentElement;
    }

    const seenTitles = new Set();
    const entries = [];
    for (const item of candidates.slice(0, 8)) {
      if (seenTitles.has(item.title)) continue;
      seenTitles.add(item.title);
      const matched = books.find((book) => book.title === item.title || book.title.includes(item.title) || item.title.includes(book.title));
      const rawHref = item.node.getAttribute?.('href') || '';
      const href = matched?.href || normalizeUrl(rawHref) || `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(item.title)}`;
      entries.push({
        href,
        title: matched?.title || item.title,
        category: '最近热搜',
        author: matched?.author || '未知作者',
        cover: matched?.cover || '',
      });
    }
    return entries;
  }

  function canonicalBookTitle(value = '') {
    return cleanText(value)
      .replace(/[《》“”"'‘’【】\[\]（）()]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  function collectHomeBooks() {
    const anchors = [...document.querySelectorAll('a[href*="/web/reader/"], a[href*="/web/bookDetail/"]')];
    const sectionMarkers = collectHomeSectionMarkers();
    const seen = new Set();
    const seenTitles = new Set();
    const books = [];

    for (const anchor of anchors) {
      const href = normalizeUrl(anchor.getAttribute('href') || anchor.href || '');
      if (!href || seen.has(href)) continue;

      const container = getBookContainer(anchor);
      const img = anchor.querySelector('img') || container.querySelector?.('img');
      const titleReject = ['大家都在读', '大家都在看', '榜单', '换一批', '最近热搜', '传书到手机', '登录', '飙升榜', '新书榜'];
      let title = '';

      const imageTitle = cleanText(img?.getAttribute('alt') || img?.getAttribute('title') || '');
      if (imageTitle && imageTitle.length <= 80 && !titleReject.some((item) => imageTitle.includes(item))) title = imageTitle;

      if (!title) {
        title = pickText(anchor, ['[class*="book"][class*="title"]', '[class*="title"]', '[class*="name"]'], titleReject);
      }

      if (!title) {
        const direct = cleanText(anchor.getAttribute('title') || anchor.textContent || '');
        if (direct && direct.length <= 50 && !titleReject.some((item) => direct.includes(item))) title = direct;
      }

      if (!title) {
        title = pickText(container, [
          '[class*="book"][class*="title"]',
          '[class*="title"]',
          '[class*="name"]',
          'h1', 'h2', 'h3', 'h4',
        ], titleReject);
      }
      if (!title || title.length < 2) continue;
      const canonicalTitle = canonicalBookTitle(title);
      if (!canonicalTitle || seenTitles.has(canonicalTitle)) continue;
      if (['大家都在看', '大家都在读', '最近热搜', '榜单', '飙升榜', '新书榜'].some((label) => canonicalTitle === canonicalBookTitle(label))) continue;

      const category = detectBookSection(anchor, sectionMarkers);
      let author = pickText(container, ['[class*="author"]', '[class*="writer"]'], [title, category]);
      if (!author) {
        const textParts = [...container.querySelectorAll?.('span, p, div') || []]
          .map((node) => cleanText(node.textContent || ''))
          .filter((value) => value && value !== title && value !== category && value.length <= 24)
          .filter((value) => !['大家都在读', '大家都在看', '最近热搜', '正在阅读', '推荐值', '换一批', '榜单'].some((word) => value.includes(word)));
        author = textParts.find((value) => !/^\d/.test(value) && !normalizeSectionName(value)) || '';
      }

      const cachedMeta = state.metadataCache.get(href);
      if (cachedMeta?.author) author = cachedMeta.author;

      seen.add(href);
      seenTitles.add(canonicalBookTitle(title));
      books.push({
        href,
        title,
        category,
        author: author || '未知作者',
        cover: cachedMeta?.cover || img?.currentSrc || img?.src || '',
      });
      if (books.length >= 18) break;
    }

    const hotEntries = collectRecentHotSearchEntries(sectionMarkers, books);
    const merged = hotEntries.length ? [...hotEntries, ...books] : books;
    const unique = [];
    const uniqueKeys = new Set();
    for (const book of merged) {
      const key = canonicalBookTitle(book.title);
      if (!key || uniqueKeys.has(key)) continue;
      uniqueKeys.add(key);
      unique.push(book);
      if (unique.length >= 18) break;
    }

    const pinned = unique
      .filter((book) => book.category === '最近热搜' || book.category === '大家都在看')
      .slice(0, 8)
      .map(({ href, title, author, category }) => ({ href, title, author, category }));
    if (pinned.length) {
      state.pinnedBooks = pinned;
      try { localStorage.setItem(STORAGE_PINNED, JSON.stringify(pinned)); } catch {}
    }
    return unique;
  }

  function parseBookMetadataFromHtml(html = '') {
    let title = '';
    let author = '';
    let cover = '';
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent || '{}');
          const list = Array.isArray(data) ? data : [data];
          for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            title ||= cleanText(item.name || item.headline || '');
            if (typeof item.author === 'string') author ||= cleanText(item.author);
            else if (Array.isArray(item.author)) author ||= cleanText(item.author.map((value) => value?.name || value).filter(Boolean).join('、'));
            else author ||= cleanText(item.author?.name || '');
            cover ||= cleanText(item.image?.url || item.image || '');
          }
        } catch {}
      }
    } catch {}

    if (!title) {
      const match = html.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (match) try { title = JSON.parse(`"${match[1]}"`); } catch { title = match[1]; }
    }
    if (!author) {
      const match = html.match(/"author"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (match) try { author = JSON.parse(`"${match[1]}"`); } catch { author = match[1]; }
    }
    return { title: cleanText(title), author: cleanText(author), cover: cleanText(cover) };
  }

  async function enrichHomeBooks(books) {
    const targets = books
      .filter((book) => book.author === '未知作者' && /^https:\/\/weread\.qq\.com\/web\/(reader|bookDetail|search\/books)/.test(book.href))
      .slice(0, 8);
    if (!targets.length) return;

    let changed = false;
    await Promise.all(targets.map(async (book) => {
      if (state.metadataCache.has(book.href)) return;
      try {
        const response = await fetch(book.href, { credentials: 'include' });
        if (!response.ok) return;
        const html = await response.text();
        const meta = parseBookMetadataFromHtml(html);
        if (meta.author || meta.title) {
          state.metadataCache.set(book.href, meta);
          changed = true;
        }
      } catch {}
    }));
    if (changed && state.enabled && state.page === PAGE.HOME) refreshHomeData();
  }

  function homeDataSignature(books) {
    return books.map((book) => `${book.href}|${book.title}|${book.author}|${book.category}`).join('::');
  }

  function initials(text = '') {
    const value = cleanText(text);
    return value ? value.slice(0, 1).toUpperCase() : '文';
  }

  function homeRowsHtml(books) {
    if (!books.length) {
      return `<tr><td colspan="6"><div class="wrf-empty">正在读取微信读书首页内容…</div></td></tr>`;
    }

    return books.map((book, index) => `
      <tr class="wrf-doc-row" data-action="open-book" data-href="${escapeHtml(book.href)}">
        <td>
          <div class="wrf-doc-title-cell">
            <span class="wrf-file-icon" aria-hidden="true"></span>
            <span class="wrf-doc-title">${escapeHtml(book.title)}</span>
          </div>
        </td>
        <td><span class="wrf-doc-location">${icon('shelf', 14)} ${escapeHtml(book.category || '其他')}</span></td>
        <td><span class="wrf-avatar">${escapeHtml(initials(book.author))}</span>${escapeHtml(book.author)}</td>
        <td>${index < 4 ? '今天' : '最近'}</td>
        <td>${index === 0 ? '刚刚' : `${Math.min(index + 1, 9)} 小时前`}</td>
        <td style="text-align:right;color:#8f959e">${icon('dots', 16)}</td>
      </tr>`).join('');
  }

  function pinnedBooksHtml(books) {
    const seen = new Set();
    const pinned = books.filter((book) => {
      if (book.category !== '最近热搜' && book.category !== '大家都在看') return false;
      const key = canonicalBookTitle(book.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);
    return pinned.map((book) => `
      <button class="wrf-nav-item" data-action="open-book" data-href="${escapeHtml(book.href)}" title="${escapeHtml(book.title)}">
        ${icon('note')}<span>${escapeHtml(book.title)}</span>
      </button>`).join('');
  }

  function parseFontPx(font = '') {
    const match = String(font).match(/([\d.]+)px/i);
    return match ? Number(match[1]) || 16 : 16;
  }

  function shouldInsertSpace(left = '', right = '', gap = 0, fontPx = 16) {
    if (gap < Math.max(2, fontPx * 0.16)) return false;
    return /[A-Za-z0-9_)\]]$/.test(left) && /^[A-Za-z0-9_(\[]/.test(right);
  }

  function getCapturedReaderLines() {
    const fragments = [];
    for (const [canvas, bucket] of [...state.canvasCapture.entries()]) {
      if (!canvas || canvas.tagName !== 'CANVAS' || !canvas.isConnected) {
        state.canvasCapture.delete(canvas);
        continue;
      }
      if (!canvas.closest('.readerContent, .app_content, .readerChapterContent')) continue;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20 || !canvas.width || !canvas.height) continue;
      const scaleX = rect.width / canvas.width;
      const scaleY = rect.height / canvas.height;
      for (const record of bucket.records.values()) {
        const fontPx = parseFontPx(record.font) * (record.scale || 1) * scaleY;
        const width = record.width * scaleX;
        let x = rect.left + record.x * scaleX;
        if (record.align === 'center') x -= width / 2;
        else if (record.align === 'right' || record.align === 'end') x -= width;
        fragments.push({
          text: cleanText(record.text),
          x,
          y: rect.top + window.scrollY + record.y * scaleY,
          width,
          fontPx,
          font: record.font,
        });
      }
    }

    fragments.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const fragment of fragments) {
      if (!fragment.text) continue;
      let row = rows[rows.length - 1];
      const tolerance = Math.max(3, fragment.fontPx * 0.22);
      if (!row || Math.abs(row.y - fragment.y) > tolerance) {
        row = { y: fragment.y, fragments: [], fontPx: fragment.fontPx, font: fragment.font };
        rows.push(row);
      }
      const duplicate = row.fragments.some((item) => Math.abs(item.x - fragment.x) < 1.5 && item.text === fragment.text);
      if (!duplicate) row.fragments.push(fragment);
      row.fontPx = Math.max(row.fontPx, fragment.fontPx);
    }

    const seen = new Set();
    const lines = [];
    for (const row of rows) {
      row.fragments.sort((a, b) => a.x - b.x);
      let text = '';
      let previousEnd = null;
      for (const fragment of row.fragments) {
        const gap = previousEnd == null ? 0 : fragment.x - previousEnd;
        if (text && shouldInsertSpace(text, fragment.text, gap, row.fontPx)) text += ' ';
        if (!text.endsWith(fragment.text) || fragment.text.length > 1) text += fragment.text;
        previousEnd = Math.max(previousEnd ?? -Infinity, fragment.x + Math.max(fragment.width, 1));
      }
      text = cleanText(text);
      if (!text || text.length > 1000) continue;
      const signature = `${Math.round(row.y / 3)}|${text}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      lines.push({
        text,
        y: row.y,
        x: row.fragments[0]?.x || 0,
        fontPx: row.fontPx,
        font: row.font,
      });
    }
    return lines;
  }

  function getInitialStateReaderBlocks() {
    let reader = null;
    try { reader = pageWindow.__INITIAL_STATE__?.reader || null; } catch {}
    if (!reader) return [];
    const candidates = [
      reader.currentChapter?.content,
      reader.currentChapter?.html,
      reader.chapterData?.content,
      reader.chapterContent,
      reader.content,
    ].filter((value) => typeof value === 'string' && value.trim().length > 20);
    if (!candidates.length) return [];

    const source = candidates.sort((a, b) => b.length - a.length)[0];
    if (!/[<>]/.test(source)) {
      return source.split(/\n{2,}|\r\n{2,}/).map((text) => ({ type: 'p', text: cleanText(text) })).filter((block) => block.text);
    }

    try {
      const doc = new DOMParser().parseFromString(`<div id="wrf-source">${source}</div>`, 'text/html');
      const root = doc.getElementById('wrf-source');
      root?.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
      const blocks = [];
      for (const node of root?.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,pre,li') || []) {
        const text = cleanText(node.textContent || '');
        if (!text) continue;
        const tag = node.tagName.toLowerCase();
        if (tag === 'h1' || tag === 'h2') blocks.push({ type: 'h2', text });
        else if (tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') blocks.push({ type: 'h3', text });
        else if (tag === 'blockquote') blocks.push({ type: 'quote', text });
        else if (tag === 'pre') blocks.push({ type: 'code', text: node.textContent || '' });
        else blocks.push({ type: 'p', text });
      }
      return blocks;
    } catch {
      return [];
    }
  }

  function getNativeReaderLines() {
    const root = document.querySelector('.readerChapterContent');
    const text = cleanText(root?.innerText || root?.textContent || '');
    if (!text || text.length < 20) return [];
    return (root?.innerText || root?.textContent || '')
      .split(/\n+/)
      .map((value, index) => ({ text: cleanText(value), y: index * 30, x: 0, fontPx: 16, font: '' }))
      .filter((item) => item.text);
  }

  function getReaderBlocks() {
    const semanticBlocks = getInitialStateReaderBlocks();
    if (semanticBlocks.length >= 2) return semanticBlocks.slice(0, 800);

    const meta = getReaderMeta();
    let lines = getCapturedReaderLines();
    if (lines.length < 3) lines = getNativeReaderLines();
    if (!lines.length) return [];

    const fontValues = lines.map((line) => line.fontPx).filter((value) => value >= 8 && value <= 64).sort((a, b) => a - b);
    const bodyFont = fontValues[Math.floor(fontValues.length * 0.45)] || 16;
    const ignored = ['上一章', '下一章', '目录', '笔记', '阅读设置', '返回顶部', '微信读书'];
    const chapterKey = canonicalBookTitle(meta.chapter);
    const bookKey = canonicalBookTitle(meta.book);
    const filtered = lines.filter((line) => {
      const key = canonicalBookTitle(line.text);
      if (!key) return false;
      if (key === chapterKey || key === bookKey) return false;
      if (ignored.some((value) => line.text === value)) return false;
      return true;
    });

    const blocks = [];
    let paragraph = [];
    let paragraphLast = null;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      let value = '';
      for (const line of paragraph) {
        if (!value) value = line.text;
        else if (/[A-Za-z0-9,.;:!?)]$/.test(value) && /^[A-Za-z0-9([]/.test(line.text)) value += ` ${line.text}`;
        else value += line.text;
      }
      value = cleanText(value);
      if (value) blocks.push({ type: 'p', text: value });
      paragraph = [];
      paragraphLast = null;
    };

    for (const line of filtered) {
      const isMono = /mono|consolas|courier/i.test(line.font || '');
      const isHeading = line.text.length <= 90 && line.fontPx >= bodyFont * 1.24;
      if (isHeading || isMono || /^>\s?/.test(line.text)) {
        flushParagraph();
        if (isMono) blocks.push({ type: 'code', text: line.text });
        else if (/^>\s?/.test(line.text)) blocks.push({ type: 'quote', text: line.text.replace(/^>\s?/, '') });
        else blocks.push({ type: line.fontPx >= bodyFont * 1.55 ? 'h2' : 'h3', text: line.text });
        continue;
      }

      if (paragraphLast) {
        const gap = line.y - paragraphLast.y;
        const indentDelta = Math.abs(line.x - paragraph[0].x);
        if (gap > Math.max(bodyFont * 2.05, 31) || indentDelta > bodyFont * 2.6) flushParagraph();
      }
      paragraph.push(line);
      paragraphLast = line;
    }
    flushParagraph();

    const deduped = [];
    for (const block of blocks) {
      const previous = deduped[deduped.length - 1];
      if (previous && previous.type === block.type && previous.text === block.text) continue;
      deduped.push(block);
    }
    return deduped.slice(0, 800);
  }

  function readerBlocksHtml(blocks) {
    if (!blocks.length) {
      return `<div class="wrf-article-loading">正在把微信读书正文转换成飞书文档排版…<br>如果刚进入章节，请等待正文完成渲染。</div>`;
    }
    return blocks.map((block) => {
      const text = escapeHtml(block.text);
      if (block.type === 'h2') return `<h2 class="wrf-md-h2">${text}</h2>`;
      if (block.type === 'h3') return `<h3 class="wrf-md-h3">${text}</h3>`;
      if (block.type === 'quote') return `<blockquote class="wrf-md-quote">${text}</blockquote>`;
      if (block.type === 'code') return `<pre class="wrf-md-code">${text}</pre>`;
      return `<p class="wrf-md-p">${text}</p>`;
    }).join('');
  }

  function getReaderMeta() {
    let stateReader = null;
    try { stateReader = pageWindow.__INITIAL_STATE__?.reader || null; } catch {}

    const titleCandidates = [
      '.readerTopBar_title_link',
      '.readerTopBar_title',
      '.bookInfo_title',
      '[class*="readerTopBar_title"]',
    ];
    const chapterCandidates = [
      '.readerTopBar_title_chapter',
      '.readerChapterContent_title',
      '.readerContentHeader_title',
      '[class*="readerTopBar_title_chapter"]',
    ];

    const textOf = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text) return text;
      }
      return '';
    };

    let book = cleanText(stateReader?.bookInfo?.title || '') || textOf(titleCandidates);
    let chapter = cleanText(stateReader?.currentChapter?.title || '') || textOf(chapterCandidates);
    let author = cleanText(stateReader?.bookInfo?.author || '');

    if (!book) {
      const title = document.title.replace(/\s*[-_|｜].*微信读书.*$/i, '').trim();
      if (title && title !== '微信读书') book = title;
    }
    if (!chapter) chapter = '正文';
    if (!book) book = '微信读书';
    if (!author) {
      const authorNode = document.querySelector('[class*="author"], [class*="writer"]');
      author = cleanText(authorNode?.textContent || '');
    }

    return { book, chapter, author: author || '微信读书' };
  }

  function queryByText(selectors, keywords) {
    const nodes = [...document.querySelectorAll(selectors.join(','))];
    return nodes.find((node) => {
      const text = `${node.textContent || ''} ${node.getAttribute?.('title') || ''} ${node.getAttribute?.('aria-label') || ''}`;
      return keywords.some((key) => text.includes(key));
    }) || null;
  }

  function clickNative(action) {
    const actions = {
      catalog: {
        direct: ['.readerControls_item.catalog', '.readerControls_catalog', '[class*="readerControls"][class*="catalog"]'],
        text: ['目录'],
      },
      note: {
        direct: ['.readerControls_item.note', '.readerControls_note', '[class*="readerControls"][class*="note"]'],
        text: ['笔记', '想法'],
      },
      font: {
        direct: ['.readerControls_item.fontSize', '.readerControls_fontSize', '[class*="readerControls"][class*="font"]'],
        text: ['字体', '字号'],
      },
    };

    const config = actions[action];
    if (!config) return false;

    for (const selector of config.direct) {
      const target = document.querySelector(selector);
      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }
    }

    const byText = queryByText(
      ['.readerControls_item', '.readerControls button', 'button', '[role="button"]'],
      config.text,
    );
    if (byText instanceof HTMLElement) {
      byText.click();
      return true;
    }

    toast(`没有找到微信读书原生「${config.text[0]}」按钮，可能是页面结构更新了。`);
    return false;
  }

  function triggerHomeSearch() {
    if (state.root && state.page === PAGE.HOME) {
      const bar = state.root.querySelector('[data-searchbar]');
      const input = state.root.querySelector('[data-search-input]');
      bar?.classList.add('open');
      if (input instanceof HTMLInputElement) {
        window.setTimeout(() => input.focus(), 0);
        return true;
      }
    }
    location.href = 'https://weread.qq.com/';
    return true;
  }

  function submitHomeSearch(keyword) {
    const value = cleanText(keyword);
    if (!value) return;
    location.href = `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(value)}`;
  }

  function clickNativeHomeText(keywords) {
    const nodes = [...document.querySelectorAll('a, button, [role="button"]')];
    const target = nodes.find((node) => keywords.some((keyword) => cleanText(node.textContent || '').includes(keyword)));
    if (target instanceof HTMLElement) {
      target.click();
      return true;
    }
    return false;
  }

  function shareCurrentPage() {
    const text = location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('已复制当前页面链接'),
        () => fallbackCopy(text),
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('已复制当前页面链接');
    } catch {
      toast('复制失败，请手动复制地址栏链接。');
    } finally {
      area.remove();
    }
  }

  function toast(message) {
    if (!state.root) return;
    const old = state.root.querySelector('.wrf-toast');
    old?.remove();
    const el = document.createElement('div');
    el.className = 'wrf-toast';
    el.textContent = message;
    el.style.cssText = `
      position:fixed; left:50%; top:72px; transform:translateX(-50%);
      pointer-events:none; z-index:99; background:#1f2329; color:white;
      padding:9px 14px; border-radius:7px; font:13px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
      box-shadow:0 7px 24px rgba(0,0,0,.18); opacity:.96;
    `;
    state.root.appendChild(el);
    window.setTimeout(() => el.remove(), 1800);
  }

  function sidebarHtml(page, books = []) {
    const reader = page === PAGE.READER;
    return `
      <aside class="wrf-sidebar">
        <div class="wrf-brand">${larkLogo()}<span>飞书云文档</span></div>
        <div class="wrf-search" data-action="search">${icon('search', 16)}<span>搜索</span></div>
        <nav class="wrf-nav">
          <button class="wrf-nav-item ${!reader ? 'active' : ''}" data-action="home">${icon('home')}<span>主页</span></button>
          <button class="wrf-nav-item" data-action="shelf">${icon('shelf')}<span>云盘</span></button>
          ${reader ? `<button class="wrf-nav-item active" data-action="catalog">${icon('catalog')}<span>目录</span></button>` : ''}
          ${reader ? `<button class="wrf-nav-item" data-action="note">${icon('note')}<span>知识库</span></button>` : `<button class="wrf-nav-item" data-action="recent">${icon('recent')}<span>知识库</span></button>`}
          ${!reader ? `<button class="wrf-nav-item" data-action="rank">${icon('rank')}<span>智能纪要</span></button>` : ''}
        </nav>
        <div class="wrf-section-title">置顶文档</div>
        <nav class="wrf-nav">
          ${pinnedBooksHtml(reader ? state.pinnedBooks : books) || `<div class="wrf-version" style="padding:8px 12px">暂无置顶文档</div>`}
        </nav>
        <div class="wrf-spacer"></div>
        <div class="wrf-version">WeRead Feishu UI · v${VERSION}</div>
      </aside>`;
  }

  function homeShellHtml(books = []) {
    return `
      <div class="wrf-shell">
        ${sidebarHtml(PAGE.HOME, books)}
        <header class="wrf-topbar">
          <div class="wrf-breadcrumb">
            <span class="wrf-home-title">主页</span>
          </div>
          <div class="wrf-top-actions">
            <button class="wrf-btn wrf-icon-btn" data-action="search" title="搜索">${icon('search', 17)}</button>
            <button class="wrf-btn wrf-icon-btn" data-action="share" title="复制页面链接">${icon('share', 17)}</button>
            <button class="wrf-btn wrf-icon-btn" data-action="more" title="更多">${icon('dots', 18)}</button>
            <span class="wrf-avatar-dot">阅</span>
          </div>
        </header>
        <div class="wrf-more-menu" data-more-menu>
          <button class="wrf-more-item" data-action="toggle-native">切回微信读书原界面 <span class="wrf-more-shortcut">Alt+F</span></button>
        </div>

        <div class="wrf-home-searchbar" data-searchbar>
          ${icon('search', 17)}
          <input data-search-input type="text" placeholder="搜索文档、书籍" autocomplete="off" />
        </div>

        <main class="wrf-home-main">
          <div class="wrf-home-inner">
            <div class="wrf-quick-actions">
              <button class="wrf-quick-card" data-action="search">
                <span class="wrf-quick-icon">${icon('note', 19)}</span>
                <span class="wrf-quick-copy"><span class="wrf-quick-title">新建</span><span class="wrf-quick-desc">搜索并打开一本书</span></span>
              </button>
              <button class="wrf-quick-card" data-action="upload">
                <span class="wrf-quick-icon">${icon('shelf', 19)}</span>
                <span class="wrf-quick-copy"><span class="wrf-quick-title">上传</span><span class="wrf-quick-desc">传书到手机或管理书架</span></span>
              </button>
              <button class="wrf-quick-card" data-action="rank">
                <span class="wrf-quick-icon">${icon('rank', 19)}</span>
                <span class="wrf-quick-copy"><span class="wrf-quick-title">模板库</span><span class="wrf-quick-desc">浏览微信读书榜单内容</span></span>
              </button>
            </div>

            <div class="wrf-home-tabs">
              <button class="wrf-home-tab active">最近访问</button>
              <button class="wrf-home-tab">归我所有</button>
              <button class="wrf-home-tab">与我共享</button>
              <button class="wrf-home-tab">收藏</button>
              <button class="wrf-home-tab">＋</button>
            </div>

            <div class="wrf-list-toolbar">
              <button class="wrf-ghost-action">筛选</button>
              <button class="wrf-ghost-action">显示设置</button>
              <button class="wrf-ghost-action">☰</button>
              <button class="wrf-ghost-action">▦</button>
            </div>

            <table class="wrf-doc-table">
              <colgroup>
                <col style="width:36%"><col style="width:18%"><col style="width:16%"><col style="width:12%"><col style="width:14%"><col style="width:4%">
              </colgroup>
              <thead>
                <tr><th>标题</th><th>位置</th><th>所有者</th><th>创建时间</th><th>最近访问 ↓</th><th></th></tr>
              </thead>
              <tbody>${homeRowsHtml(books)}</tbody>
            </table>
          </div>
        </main>
      </div>`;
  }

  function extractChapterUid(node) {
    if (!(node instanceof Element)) return '';
    const chain = [node, node.closest('[data-chapter-uid], [data-chapteruid], [data-uid]')].filter(Boolean);
    for (const el of chain) {
      const values = [
        el.getAttribute?.('data-chapter-uid'),
        el.getAttribute?.('data-chapteruid'),
        el.getAttribute?.('data-uid'),
      ];
      const value = values.find((item) => item != null && /^\d+$/.test(String(item)));
      if (value != null) return String(value);
    }
    return '';
  }

  function getActionHref(node) {
    if (!(node instanceof Element)) return '';
    const anchor = node.matches('a[href]') ? node : (node.closest('a[href]') || node.querySelector('a[href]'));
    return anchor instanceof HTMLAnchorElement ? normalizeUrl(anchor.getAttribute('href') || anchor.href || '') : '';
  }

  function isTocVolumeTitle(title = '') {
    return /^(第[一二三四五六七八九十百千万零〇0-9]+[卷部篇辑册编]|卷[一二三四五六七八九十百千万零〇0-9]+|part\s*[ivx0-9]+)/i.test(cleanText(title));
  }

  function isTocChapterTitle(title = '') {
    return /^(第[一二三四五六七八九十百千万零〇0-9]+章|chapter\s*\d+)/i.test(cleanText(title));
  }

  function isTocFrontMatterTitle(title = '') {
    return /^(序章|序言|前言|楔子|引子|版权信息|版权声明|书籍封面|封面|目录|后记|附录|跋|致谢)/.test(cleanText(title));
  }

  function isTocSubsectionTitle(title = '') {
    const text = cleanText(title);
    return /^(\d+(?:\.\d+)+|[一二三四五六七八九十]+、|\([一二三四五六七八九十0-9]+\)|（[一二三四五六七八九十0-9]+）|第[一二三四五六七八九十百千万零〇0-9]+[节小节])/.test(text);
  }

  function inferTocLevelFromTitle(title = '', context = {}) {
    const text = cleanText(title);
    if (!text) return 0;
    if (isTocFrontMatterTitle(text) || isTocVolumeTitle(text)) return 0;
    if (isTocChapterTitle(text)) return context.hasVolume ? 1 : 0;
    if (isTocSubsectionTitle(text)) return Math.min(4, (context.currentChapterLevel ?? (context.hasVolume ? 1 : 0)) + 1);
    if (context.seenChapter) return Math.min(4, (context.currentChapterLevel ?? 0) + 1);
    return 0;
  }

  function getNativeTocRawIndent(node) {
    if (!(node instanceof Element)) return 0;
    const target = node.closest('a,button,[role="button"],[class*="item"],[class*="chapter"]') || node;
    try {
      const style = pageWindow.getComputedStyle(target);
      const padding = parseFloat(style.paddingLeft) || 0;
      const margin = parseFloat(style.marginLeft) || 0;
      return Math.max(0, padding + margin);
    } catch {
      return 0;
    }
  }

  function normalizeTocLevels(items) {
    if (!items.length) return items;

    // 微信读书很多 EPUB 的 chapterInfos.level 全部都是 1；这种数据并不代表
    // “所有章节同级”，不能直接拿来画树。只有出现至少两个不同 level 时才采用。
    const explicitValues = items
      .map((item) => Number.isFinite(item.level) ? Number(item.level) : null)
      .filter((value) => value != null);
    const explicitUnique = [...new Set(explicitValues)];
    const hasUsefulExplicitLevels = explicitUnique.length >= 2;
    const explicitMin = hasUsefulExplicitLevels ? Math.min(...explicitUnique) : 0;

    const indents = [...new Set(items
      .map((item) => Math.round(item.rawIndent || 0))
      .filter((value) => value > 0))].sort((a, b) => a - b);
    const hasUsefulIndents = indents.length >= 2;
    const hasVolume = items.some((item) => isTocVolumeTitle(item.title));

    let seenChapter = false;
    let currentChapterLevel = hasVolume ? 1 : 0;

    return items.map((item) => {
      let level = null;

      if (hasUsefulExplicitLevels && Number.isFinite(item.level)) {
        level = Number(item.level) - explicitMin;
      } else if (hasUsefulIndents && item.rawIndent > 0) {
        const nearest = indents.reduce((best, value, index) => {
          const delta = Math.abs(value - item.rawIndent);
          return delta < best.delta ? { index, delta } : best;
        }, { index: 0, delta: Infinity });
        level = nearest.index;
      } else {
        if (isTocChapterTitle(item.title)) {
          seenChapter = true;
          currentChapterLevel = hasVolume ? 1 : 0;
        }
        level = inferTocLevelFromTitle(item.title, { hasVolume, seenChapter, currentChapterLevel });
      }

      return { ...item, level: Math.max(0, Math.min(4, Number(level) || 0)) };
    });
  }

  function collectNativeTocItems() {
    const panel = document.querySelector('.readerCatalog, [class*="readerCatalog"]');
    if (!(panel instanceof Element)) return [];
    const candidates = [...panel.querySelectorAll('a, button, [role="button"], [class*="item"], [class*="chapter"]')];
    const seen = new Set();
    const items = [];
    for (const node of candidates) {
      const title = cleanText(node.textContent || node.getAttribute?.('title') || '');
      if (!title || title.length > 120) continue;
      if (['目录', '关闭', '返回'].includes(title)) continue;
      const key = canonicalBookTitle(title);
      if (!key || seen.has(key)) continue;
      const href = getActionHref(node);
      const chapterUid = extractChapterUid(node);
      const dataLevel = [
        node.getAttribute?.('data-level'),
        node.getAttribute?.('data-depth'),
        node.getAttribute?.('data-indent'),
      ].map(Number).find(Number.isFinite);
      seen.add(key);
      items.push({
        title,
        href,
        chapterUid,
        node,
        level: Number.isFinite(dataLevel) ? dataLevel : null,
        rawIndent: getNativeTocRawIndent(node),
      });
      if (items.length >= 300) break;
    }
    return normalizeTocLevels(items);
  }

  function getReaderBookId() {
    try {
      const fromState = String(pageWindow.__INITIAL_STATE__?.reader?.bookInfo?.bookId || '').trim();
      if (fromState) return fromState;
    } catch {}

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || '{}');
        const values = Array.isArray(data) ? data : [data];
        for (const item of values) {
          const raw = item?.bookId ?? item?.['@Id'] ?? item?.['@id'] ?? '';
          const match = String(raw).match(/(?:bookId[=/:])?([A-Za-z0-9_]+)$/);
          if (match?.[1]) return match[1];
        }
      } catch {}
    }

    for (const script of document.scripts) {
      const text = script.textContent || '';
      if (!text.includes('bookId')) continue;
      const match = text.match(/["']bookId["']\s*:\s*["']([^"']+)["']/);
      if (match?.[1]) return match[1];
    }
    return '';
  }

  function getReaderBookHash() {
    const match = location.pathname.match(/^\/web\/reader\/([^/?#]+)/);
    if (!match) return '';
    return match[1].split('k')[0];
  }

  function getReaderChapterHash() {
    const match = location.pathname.match(/^\/web\/reader\/[^/?#]+k([^/?#]+)/);
    return match ? match[1] : '';
  }

  // WeRead reader URL 使用 _e(chapterUid) 而不是 progressChapterUid query。
  // 这里只需要处理数字 chapterUid，因此一个同步 MD5 即可。
  function md5Ascii(input) {
    const rotateLeft = (value, shift) => (value << shift) | (value >>> (32 - shift));
    const addUnsigned = (x, y) => {
      const x4 = x & 0x40000000;
      const y4 = y & 0x40000000;
      const x8 = x & 0x80000000;
      const y8 = y & 0x80000000;
      const result = (x & 0x3fffffff) + (y & 0x3fffffff);
      if (x4 & y4) return result ^ 0x80000000 ^ x8 ^ y8;
      if (x4 | y4) return (result & 0x40000000) ? result ^ 0xc0000000 ^ x8 ^ y8 : result ^ 0x40000000 ^ x8 ^ y8;
      return result ^ x8 ^ y8;
    };
    const F = (x, y, z) => (x & y) | (~x & z);
    const G = (x, y, z) => (x & z) | (y & ~z);
    const H = (x, y, z) => x ^ y ^ z;
    const I = (x, y, z) => y ^ (x | ~z);
    const step = (fn, a, b, c, d, x, s, ac) => addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(fn(b, c, d), x), ac)), s), b);
    const str = String(input);
    const length = str.length;
    const words = [];
    let i;
    for (i = 0; i < length; i += 1) {
      const wordIndex = (i - (i % 4)) / 4;
      const bytePos = (i % 4) * 8;
      words[wordIndex] = (words[wordIndex] || 0) | (str.charCodeAt(i) << bytePos);
    }
    const wordIndex = (i - (i % 4)) / 4;
    const bytePos = (i % 4) * 8;
    words[wordIndex] = (words[wordIndex] || 0) | (0x80 << bytePos);
    const totalWords = (((length + 8) >>> 6) + 1) * 16;
    while (words.length < totalWords) words.push(0);
    words[totalWords - 2] = length << 3;
    words[totalWords - 1] = length >>> 29;

    let a = 0x67452301;
    let b = 0xefcdab89;
    let c = 0x98badcfe;
    let d = 0x10325476;
    const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
    const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
    const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
    const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

    for (let k = 0; k < totalWords; k += 16) {
      const AA = a, BB = b, CC = c, DD = d;
      a = step(F, a,b,c,d,words[k+0], S11,0xd76aa478); d = step(F,d,a,b,c,words[k+1], S12,0xe8c7b756);
      c = step(F,c,d,a,b,words[k+2], S13,0x242070db); b = step(F,b,c,d,a,words[k+3], S14,0xc1bdceee);
      a = step(F,a,b,c,d,words[k+4], S11,0xf57c0faf); d = step(F,d,a,b,c,words[k+5], S12,0x4787c62a);
      c = step(F,c,d,a,b,words[k+6], S13,0xa8304613); b = step(F,b,c,d,a,words[k+7], S14,0xfd469501);
      a = step(F,a,b,c,d,words[k+8], S11,0x698098d8); d = step(F,d,a,b,c,words[k+9], S12,0x8b44f7af);
      c = step(F,c,d,a,b,words[k+10],S13,0xffff5bb1); b = step(F,b,c,d,a,words[k+11],S14,0x895cd7be);
      a = step(F,a,b,c,d,words[k+12],S11,0x6b901122); d = step(F,d,a,b,c,words[k+13],S12,0xfd987193);
      c = step(F,c,d,a,b,words[k+14],S13,0xa679438e); b = step(F,b,c,d,a,words[k+15],S14,0x49b40821);

      a = step(G,a,b,c,d,words[k+1], S21,0xf61e2562); d = step(G,d,a,b,c,words[k+6], S22,0xc040b340);
      c = step(G,c,d,a,b,words[k+11],S23,0x265e5a51); b = step(G,b,c,d,a,words[k+0], S24,0xe9b6c7aa);
      a = step(G,a,b,c,d,words[k+5], S21,0xd62f105d); d = step(G,d,a,b,c,words[k+10],S22,0x02441453);
      c = step(G,c,d,a,b,words[k+15],S23,0xd8a1e681); b = step(G,b,c,d,a,words[k+4], S24,0xe7d3fbc8);
      a = step(G,a,b,c,d,words[k+9], S21,0x21e1cde6); d = step(G,d,a,b,c,words[k+14],S22,0xc33707d6);
      c = step(G,c,d,a,b,words[k+3], S23,0xf4d50d87); b = step(G,b,c,d,a,words[k+8], S24,0x455a14ed);
      a = step(G,a,b,c,d,words[k+13],S21,0xa9e3e905); d = step(G,d,a,b,c,words[k+2], S22,0xfcefa3f8);
      c = step(G,c,d,a,b,words[k+7], S23,0x676f02d9); b = step(G,b,c,d,a,words[k+12],S24,0x8d2a4c8a);

      a = step(H,a,b,c,d,words[k+5], S31,0xfffa3942); d = step(H,d,a,b,c,words[k+8], S32,0x8771f681);
      c = step(H,c,d,a,b,words[k+11],S33,0x6d9d6122); b = step(H,b,c,d,a,words[k+14],S34,0xfde5380c);
      a = step(H,a,b,c,d,words[k+1], S31,0xa4beea44); d = step(H,d,a,b,c,words[k+4], S32,0x4bdecfa9);
      c = step(H,c,d,a,b,words[k+7], S33,0xf6bb4b60); b = step(H,b,c,d,a,words[k+10],S34,0xbebfbc70);
      a = step(H,a,b,c,d,words[k+13],S31,0x289b7ec6); d = step(H,d,a,b,c,words[k+0], S32,0xeaa127fa);
      c = step(H,c,d,a,b,words[k+3], S33,0xd4ef3085); b = step(H,b,c,d,a,words[k+6], S34,0x04881d05);
      a = step(H,a,b,c,d,words[k+9], S31,0xd9d4d039); d = step(H,d,a,b,c,words[k+12],S32,0xe6db99e5);
      c = step(H,c,d,a,b,words[k+15],S33,0x1fa27cf8); b = step(H,b,c,d,a,words[k+2], S34,0xc4ac5665);

      a = step(I,a,b,c,d,words[k+0], S41,0xf4292244); d = step(I,d,a,b,c,words[k+7], S42,0x432aff97);
      c = step(I,c,d,a,b,words[k+14],S43,0xab9423a7); b = step(I,b,c,d,a,words[k+5], S44,0xfc93a039);
      a = step(I,a,b,c,d,words[k+12],S41,0x655b59c3); d = step(I,d,a,b,c,words[k+3], S42,0x8f0ccc92);
      c = step(I,c,d,a,b,words[k+10],S43,0xffeff47d); b = step(I,b,c,d,a,words[k+1], S44,0x85845dd1);
      a = step(I,a,b,c,d,words[k+8], S41,0x6fa87e4f); d = step(I,d,a,b,c,words[k+15],S42,0xfe2ce6e0);
      c = step(I,c,d,a,b,words[k+6], S43,0xa3014314); b = step(I,b,c,d,a,words[k+13],S44,0x4e0811a1);
      a = step(I,a,b,c,d,words[k+4], S41,0xf7537e82); d = step(I,d,a,b,c,words[k+11],S42,0xbd3af235);
      c = step(I,c,d,a,b,words[k+2], S43,0x2ad7d2bb); b = step(I,b,c,d,a,words[k+9], S44,0xeb86d391);

      a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
    }

    const hex = (value) => {
      let out = '';
      for (let j = 0; j <= 3; j += 1) out += (`0${((value >>> (j * 8)) & 255).toString(16)}`).slice(-2);
      return out;
    };
    return `${hex(a)}${hex(b)}${hex(c)}${hex(d)}`.toLowerCase();
  }

  function wereadEncodeId(value) {
    const text = String(value ?? '');
    if (!text) return '';
    const hash = md5Ascii(text);
    let result = hash.slice(0, 3);
    let chunks;
    let typeFlag;
    if (/^\d+$/.test(text)) {
      chunks = text.match(/.{1,9}/g).map((part) => Number(part).toString(16));
      typeFlag = '3';
    } else {
      chunks = [Array.from(text).map((char) => char.charCodeAt(0).toString(16)).join('')];
      typeFlag = '4';
    }
    result += `${typeFlag}2${hash.slice(-2)}`;
    result += chunks.map((chunk) => `${chunk.length.toString(16).padStart(2, '0')}${chunk}`).join('g');
    if (result.length < 20) result += hash.slice(0, 20 - result.length);
    result += md5Ascii(result).slice(0, 3);
    return result;
  }

  function buildReaderChapterUrl(chapterUid) {
    const uid = String(chapterUid || '').trim();
    const bookHash = getReaderBookHash();
    const chapterHash = wereadEncodeId(uid);
    if (!uid || !bookHash || !chapterHash) return '';
    return `${location.origin}/web/reader/${bookHash}k${chapterHash}`;
  }

  function getCurrentReaderChapterUid() {
    try {
      const chapter = pageWindow.__INITIAL_STATE__?.reader?.currentChapter;
      const uid = String(chapter?.chapterUid ?? chapter?.uid ?? '').trim();
      if (uid) return uid;
    } catch {}
    const chapterHash = getReaderChapterHash();
    if (!chapterHash || !state.readerTocItems.length) return '';
    const matched = state.readerTocItems.find((item) => item?.chapterUid && wereadEncodeId(item.chapterUid) === chapterHash);
    return String(matched?.chapterUid || '');
  }

  function getReaderTocStorageKey() {
    const hash = getReaderBookHash();
    if (hash) return `hash:${hash}`;
    const bookId = getReaderBookId();
    if (bookId) return `id:${bookId}`;
    const title = canonicalBookTitle(getReaderMeta().book || '');
    return title ? `title:${title}` : 'unknown';
  }

  function tocItemStableKey(item, index) {
    const uid = String(item?.chapterUid || '').trim();
    if (uid) return `uid:${uid}`;
    return `title:${canonicalBookTitle(item?.title || '')}|level:${Number(item?.level) || 0}|index:${index}`;
  }

  function getReaderCollapsedTocSet() {
    const key = getReaderTocStorageKey();
    const values = state.readerTocCollapsedByBook[key];
    return new Set(Array.isArray(values) ? values : []);
  }

  function saveReaderCollapsedTocSet(collapsed) {
    const key = getReaderTocStorageKey();
    state.readerTocCollapsedByBook[key] = [...collapsed];
    try {
      localStorage.setItem(STORAGE_READER_TOC_COLLAPSED, JSON.stringify(state.readerTocCollapsedByBook));
    } catch {}
  }

  function setReaderTocOpen(open) {
    state.readerTocOpen = Boolean(open);
    localStorage.setItem(STORAGE_READER_TOC_OPEN, state.readerTocOpen ? '1' : '0');
  }

  function findActiveTocIndex(items, meta = getReaderMeta()) {
    const currentUid = getCurrentReaderChapterUid();
    if (currentUid) {
      const byUid = items.findIndex((item) => String(item?.chapterUid || '') === currentUid);
      if (byUid >= 0) return byUid;
    }
    const wanted = canonicalBookTitle(meta?.chapter || '');
    if (!wanted) return -1;
    return items.findIndex((item) => canonicalBookTitle(item?.title || '') === wanted);
  }

  function hasTocChildren(items, index) {
    const currentLevel = Math.max(0, Number(items[index]?.level) || 0);
    const nextLevel = Math.max(0, Number(items[index + 1]?.level) || 0);
    return index < items.length - 1 && nextLevel > currentLevel;
  }

  function ensureActiveTocAncestorsExpanded(items, meta = getReaderMeta()) {
    const activeIndex = findActiveTocIndex(items, meta);
    if (activeIndex <= 0) return false;
    const collapsed = getReaderCollapsedTocSet();
    let level = Math.max(0, Number(items[activeIndex]?.level) || 0);
    let changed = false;
    for (let index = activeIndex - 1; index >= 0 && level > 0; index -= 1) {
      const parentLevel = Math.max(0, Number(items[index]?.level) || 0);
      if (parentLevel >= level) continue;
      const key = tocItemStableKey(items[index], index);
      if (collapsed.delete(key)) changed = true;
      level = parentLevel;
    }
    if (changed) saveReaderCollapsedTocSet(collapsed);
    return changed;
  }

  function toggleReaderTocGroup(index) {
    const items = state.readerTocItems;
    if (!items[index] || !hasTocChildren(items, index)) return;
    const collapsed = getReaderCollapsedTocSet();
    const key = tocItemStableKey(items[index], index);
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    saveReaderCollapsedTocSet(collapsed);
    renderShell(true);
  }

  function scrollReaderTocToActive(behavior = 'auto') {
    if (!state.readerTocOpen || !state.root) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const outline = state.root?.querySelector('.wrf-reader-outline');
        const active = state.root?.querySelector('.wrf-outline-row.active');
        if (!(outline instanceof HTMLElement) || !(active instanceof HTMLElement)) return;
        const top = active.offsetTop;
        const bottom = top + active.offsetHeight;
        const visibleTop = outline.scrollTop + 24;
        const visibleBottom = outline.scrollTop + outline.clientHeight - 24;
        if (top >= visibleTop && bottom <= visibleBottom) return;
        outline.scrollTo({
          top: Math.max(0, top - outline.clientHeight * .38),
          behavior,
        });
      });
    });
  }

  async function fetchOfficialReaderToc() {
    if (state.readerOfficialToc.length) return state.readerOfficialToc;
    if (state.readerOfficialTocPromise) return state.readerOfficialTocPromise;

    const bookId = getReaderBookId();
    if (!bookId) return [];

    state.readerOfficialTocPromise = fetch('/web/book/chapterInfos', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ bookIds: [bookId] }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`chapterInfos ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        const records = Array.isArray(payload?.data) ? payload.data : [];
        const record = records[0] || payload?.data || payload || {};
        const chapters = record?.updated || record?.chapters || payload?.updated || payload?.chapters || [];
        state.readerOfficialToc = Array.isArray(chapters)
          ? normalizeTocLevels(chapters
              .map((chapter) => {
                const rawLevel = [
                  chapter?.level,
                  chapter?.depth,
                  chapter?.indent,
                  chapter?.chapterLevel,
                  chapter?.hierarchy,
                ].map(Number).find(Number.isFinite);
                return {
                  title: cleanText(chapter?.title || ''),
                  chapterUid: String(chapter?.chapterUid ?? ''),
                  chapterIdx: Number(chapter?.chapterIdx ?? -1),
                  level: Number.isFinite(rawLevel) ? rawLevel : null,
                };
              })
              .filter((chapter) => chapter.title && chapter.chapterUid))
          : [];
        return state.readerOfficialToc;
      })
      .catch((error) => {
        console.warn(`[${APP_ID}] chapter catalog fetch failed`, error);
        return [];
      })
      .finally(() => {
        state.readerOfficialTocPromise = null;
      });

    return state.readerOfficialTocPromise;
  }

  function findLiveNativeTocItem(index, title) {
    const liveItems = collectNativeTocItems();
    if (!liveItems.length) return null;
    const wanted = canonicalBookTitle(title || '');
    const indexed = Number.isInteger(index) ? liveItems[index] : null;
    if (indexed && (!wanted || canonicalBookTitle(indexed.title) === wanted)) return indexed;
    return liveItems.find((item) => canonicalBookTitle(item.title) === wanted) || null;
  }

  function dispatchNativeClick(node) {
    if (!(node instanceof Element) || !node.isConnected) return false;
    const target = node.closest('a,button,[role="button"],[class*="item"],[class*="chapter"]') || node;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: pageWindow }));
      } catch {}
    }
    return true;
  }

  async function navigateToReaderTocItem(index, title) {
    const savedItem = state.readerTocItems[index] || null;

    if (savedItem?.href) {
      location.assign(savedItem.href);
      return;
    }

    if (savedItem?.chapterUid) {
      const url = buildReaderChapterUrl(savedItem.chapterUid);
      if (url) {
        location.assign(url);
        return;
      }
    }

    const official = await fetchOfficialReaderToc();
    const wanted = canonicalBookTitle(title || savedItem?.title || '');
    let chapter = official.find((item) => canonicalBookTitle(item.title) === wanted);
    if (!chapter && Number.isInteger(index) && official[index]) chapter = official[index];
    if (chapter?.chapterUid) {
      const url = buildReaderChapterUrl(chapter.chapterUid);
      if (url) {
        location.assign(url);
        return;
      }
    }

    const clickLiveItem = () => {
      const item = findLiveNativeTocItem(index, title || savedItem?.title || '');
      if (!item) return false;
      if (item.href) {
        location.assign(item.href);
        return true;
      }
      if (item.chapterUid) {
        const url = buildReaderChapterUrl(item.chapterUid);
        if (url) {
          location.assign(url);
          return true;
        }
      }
      return dispatchNativeClick(item.node);
    };

    if (clickLiveItem()) return;

    if (clickNative('catalog')) {
      window.setTimeout(() => {
        if (!clickLiveItem()) toast(`暂时无法跳转到「${title}」`);
      }, 120);
      return;
    }

    toast(`暂时无法跳转到「${title}」`);
  }

  function mergeTocLevelsFromOfficial(items, official) {
    if (!items.length || !official.length) return items;
    const byUid = new Map(official.filter((item) => item.chapterUid).map((item) => [String(item.chapterUid), item]));
    const byTitle = new Map(official.map((item) => [canonicalBookTitle(item.title), item]));
    return normalizeTocLevels(items.map((item) => {
      const match = byUid.get(String(item.chapterUid || '')) || byTitle.get(canonicalBookTitle(item.title));
      return match ? { ...item, level: match.level, chapterUid: item.chapterUid || match.chapterUid } : item;
    }));
  }

  function enrichReaderTocLevels() {
    fetchOfficialReaderToc().then((official) => {
      if (!official.length || !state.readerTocItems.length) return;
      const merged = mergeTocLevelsFromOfficial(state.readerTocItems, official);
      const before = state.readerTocItems.map((item) => item.level).join(',');
      const after = merged.map((item) => item.level).join(',');
      state.readerTocItems = merged;
      ensureActiveTocAncestorsExpanded(state.readerTocItems);
      if (before !== after && state.enabled && state.page === PAGE.READER) {
        renderShell(true);
        scrollReaderTocToActive();
      }
    });
  }

  function scheduleReaderTocPrimeRetry() {
    if (!state.enabled || state.page !== PAGE.READER || !state.readerTocOpen) return;
    if (state.readerTocItems.length || state.readerTocPrimeAttempts >= 12) return;
    window.clearTimeout(state.readerTocPrimeTimer);
    state.readerTocPrimeAttempts += 1;
    state.readerTocPrimeTimer = window.setTimeout(() => primeReaderToc(), Math.min(1200, 180 + state.readerTocPrimeAttempts * 90));
  }

  async function primeReaderToc() {
    if (!state.enabled || state.page !== PAGE.READER || !state.readerTocOpen) return;

    if (state.readerTocItems.length) {
      state.readerTocPrimeAttempts = 0;
      ensureActiveTocAncestorsExpanded(state.readerTocItems);
      renderShell(true);
      scrollReaderTocToActive();
      return;
    }

    const official = await fetchOfficialReaderToc();
    if (official.length) {
      state.readerTocPrimeAttempts = 0;
      state.readerTocItems = official;
      ensureActiveTocAncestorsExpanded(state.readerTocItems);
      renderShell(true);
      scrollReaderTocToActive();
      return;
    }

    const existing = collectNativeTocItems();
    if (existing.length) {
      state.readerTocPrimeAttempts = 0;
      state.readerTocItems = existing;
      ensureActiveTocAncestorsExpanded(state.readerTocItems);
      renderShell(true);
      enrichReaderTocLevels();
      scrollReaderTocToActive();
      return;
    }

    if (!clickNative('catalog')) {
      scheduleReaderTocPrimeRetry();
      return;
    }

    window.setTimeout(() => {
      const items = collectNativeTocItems();
      if (items.length) {
        state.readerTocPrimeAttempts = 0;
        state.readerTocItems = items;
        ensureActiveTocAncestorsExpanded(state.readerTocItems);
        enrichReaderTocLevels();
      }
      clickNative('catalog');
      renderShell(true);
      scrollReaderTocToActive();
      if (!items.length) scheduleReaderTocPrimeRetry();
    }, 220);
  }

  function readerOutlineHtml(meta, blocks) {
    let items = state.readerTocItems;
    if (!items.length) {
      const headings = blocks.filter((block) => block.type === 'h2' || block.type === 'h3').slice(0, 24);
      items = normalizeTocLevels([
        { title: meta.chapter, active: true, level: 0 },
        ...headings.map((block) => ({ title: block.text, level: block.type === 'h2' ? 1 : 2 })),
      ]);
    }

    if (!items.length) {
      return `<aside class="wrf-reader-outline ${state.readerTocOpen ? '' : 'hidden'}"><div class="wrf-outline-title">目录</div><div class="wrf-outline-empty">正在读取目录…</div></aside>`;
    }

    const collapsed = getReaderCollapsedTocSet();
    const activeIndex = findActiveTocIndex(items, meta);
    const collapsedAncestors = [];
    const rows = [];

    items.forEach((item, index) => {
      const level = Math.max(0, Math.min(4, Number(item.level) || 0));
      while (collapsedAncestors.length && level <= collapsedAncestors[collapsedAncestors.length - 1].level) {
        collapsedAncestors.pop();
      }

      const hiddenByAncestor = collapsedAncestors.length > 0;
      const hasChildren = hasTocChildren(items, index);
      const key = tocItemStableKey(item, index);
      const isCollapsed = hasChildren && collapsed.has(key);
      const active = item.active || index === activeIndex;

      if (!hiddenByAncestor) {
        const fold = hasChildren
          ? `<button class="wrf-outline-fold ${isCollapsed ? 'collapsed' : ''}" data-action="toc-fold" data-toc-index="${index}" aria-label="${isCollapsed ? '展开' : '收起'} ${escapeHtml(item.title)}">${icon('chevron', 13)}</button>`
          : `<span class="wrf-outline-fold placeholder">${icon('chevron', 13)}</span>`;
        rows.push(`
          <div class="wrf-outline-row ${active ? 'active' : ''}" data-toc-index="${index}" data-level="${level}" style="--wrf-toc-level:${level}">
            ${fold}
            <button class="wrf-outline-item" data-action="toc-item" data-toc-index="${index}" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</button>
          </div>`);
      }

      if (isCollapsed) collapsedAncestors.push({ level, index });
    });

    return `<aside class="wrf-reader-outline ${state.readerTocOpen ? '' : 'hidden'}"><div class="wrf-outline-title">目录</div>${rows.join('')}</aside>`;
  }

  function readerShellHtml() {
    const meta = getReaderMeta();
    const blocks = getReaderBlocks();
    const tocTooltip = state.readerTocOpen ? '收起目录' : '展开目录';
    return `
      <div class="wrf-shell wrf-reader-shell">
        ${sidebarHtml(PAGE.READER)}
        <header class="wrf-topbar">
          <div class="wrf-breadcrumb">
            <span class="strong">${escapeHtml(meta.book)}</span>
            ${icon('chevron', 13)}
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
        </header>
        <div class="wrf-more-menu" data-more-menu>
          <button class="wrf-more-item" data-action="note">笔记</button>
          <button class="wrf-more-item" data-action="font">阅读设置</button>
          <button class="wrf-more-item" data-action="toggle-native">切回微信读书原界面 <span class="wrf-more-shortcut">Alt+F</span></button>
        </div>
        ${readerOutlineHtml(meta, blocks)}
        <button class="wrf-toc-toggle ${state.readerTocOpen ? 'open' : ''}" data-action="toc-toggle" data-tooltip="${tocTooltip}" aria-label="${tocTooltip}">
          ${icon('catalog', 18)}
        </button>
        <main class="wrf-reader-main ${state.readerTocOpen ? 'with-outline' : ''}" data-reader-main>
          <article class="wrf-article">
            <h1 class="wrf-article-title">${escapeHtml(meta.chapter)}</h1>
            <div class="wrf-article-meta"><span>${escapeHtml(meta.author)}</span><span>·</span><span>${escapeHtml(meta.book)}</span></div>
            <div class="wrf-article-divider"></div>
            <div class="wrf-article-body" data-reader-body>${readerBlocksHtml(blocks)}</div>
          </article>
        </main>
      </div>`;
  }

  function nativeReturnShellHtml() {
    return `
      <div class="wrf-shell">
        <button class="wrf-native-return" data-action="return-feishu" title="也可以按 Alt+F">返回飞书模式</button>
      </div>`;
  }

  function bindShellEvents() {
    if (!state.root) return;
    state.root.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', () => {
        const action = el.getAttribute('data-action');
        switch (action) {
          case 'home':
            location.href = 'https://weread.qq.com/';
            break;
          case 'shelf':
            location.href = 'https://weread.qq.com/web/shelf';
            break;
          case 'search':
            if (state.page === PAGE.HOME) triggerHomeSearch();
            else {
              location.href = 'https://weread.qq.com/';
              window.setTimeout(triggerHomeSearch, 450);
            }
            break;
          case 'catalog':
          case 'toc-toggle': {
            setReaderTocOpen(!state.readerTocOpen);
            renderShell(true);
            if (state.readerTocOpen) {
              if (!state.readerTocItems.length) primeReaderToc();
              else scrollReaderTocToActive();
            }
            break;
          }
          case 'toc-fold': {
            const index = Number(el.getAttribute('data-toc-index'));
            toggleReaderTocGroup(index);
            break;
          }
          case 'note': clickNative('note'); break;
          case 'font': clickNative('font'); break;
          case 'open-book': {
            const href = el.getAttribute('data-href');
            if (href) location.href = href;
            break;
          }
          case 'toc-item': {
            const index = Number(el.getAttribute('data-toc-index'));
            const title = cleanText(el.textContent || '');
            const item = state.readerTocItems[index];
            if (item) {
              navigateToReaderTocItem(index, title);
            } else {
              const headings = [...state.root.querySelectorAll('.wrf-md-h2, .wrf-md-h3')];
              const target = headings.find((node) => cleanText(node.textContent || '') === title);
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
              else toast(`暂时无法跳转到「${title}」`);
            }
            break;
          }
          case 'upload':
            if (!clickNativeHomeText(['传书到手机', '上传'])) location.href = 'https://weread.qq.com/web/shelf';
            break;
          case 'recent':
            state.root?.querySelector('.wrf-home-main')?.scrollTo({ top: 0, behavior: 'smooth' });
            break;
          case 'rank': {
            const target = queryByText(['a', 'button', '[role="button"]'], ['榜单']);
            if (target instanceof HTMLElement) target.click();
            else toast('当前页面没有可打开的榜单入口');
            break;
          }
          case 'share': shareCurrentPage(); break;
          case 'toggle-native': setEnabled(false); break;
          case 'return-feishu': setEnabled(true); break;
          case 'more': {
            state.root?.querySelector('[data-more-menu]')?.classList.toggle('open');
            break;
          }
        }
      });
    });

    const searchInput = state.root.querySelector('[data-search-input]');
    if (searchInput instanceof HTMLInputElement) {
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitHomeSearch(searchInput.value);
        } else if (event.key === 'Escape') {
          state.root?.querySelector('[data-searchbar]')?.classList.remove('open');
        }
      });
    }

    const readerMain = state.root.querySelector('[data-reader-main]');
    if (readerMain instanceof HTMLElement) {
      let syncing = false;
      readerMain.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        window.requestAnimationFrame(() => {
          const overlayMax = Math.max(1, readerMain.scrollHeight - readerMain.clientHeight);
          const nativeMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          if (nativeMax > 0) window.scrollTo(0, (readerMain.scrollTop / overlayMax) * nativeMax);
          syncing = false;
        });
      }, { passive: true });
      readerMain.addEventListener('wheel', (event) => {
        const atBottom = readerMain.scrollTop + readerMain.clientHeight >= readerMain.scrollHeight - 24;
        const atTop = readerMain.scrollTop <= 24;
        if ((event.deltaY > 0 && atBottom) || (event.deltaY < 0 && atTop)) {
          window.scrollBy({ top: event.deltaY * 2.2, behavior: 'auto' });
        }
      }, { passive: true });
    }
  }

  function renderShell(force = false) {
    if (state.page === PAGE.NONE) {
      if (state.host) state.host.style.display = 'none';
      return;
    }

    ensureHost();
    state.host.style.display = '';

    if (!state.enabled) {
      const marker = `native:${state.page}:${location.pathname}`;
      if (!force && state.shellMarker === marker) return;
      state.shellMarker = marker;
      state.root.innerHTML = `<style>${shellCss}</style>${nativeReturnShellHtml()}`;
      bindShellEvents();
      return;
    }

    const marker = `feishu:${state.page}:${location.pathname}`;
    if (!force && state.shellMarker === marker) {
      if (state.page === PAGE.READER) refreshReaderMeta();
      return;
    }

    state.shellMarker = marker;
    const books = state.page === PAGE.HOME ? collectHomeBooks() : [];
    if (state.page === PAGE.HOME) state.homeDataSignature = homeDataSignature(books);
    state.root.innerHTML = `<style>${shellCss}</style>${state.page === PAGE.READER ? readerShellHtml() : homeShellHtml(books)}`;
    bindShellEvents();
    if (state.page === PAGE.HOME) {
      queueMicrotask(() => enrichHomeBooks(books));
    } else if (state.page === PAGE.READER && state.readerTocOpen) {
      queueMicrotask(() => {
        if (!state.readerTocItems.length) primeReaderToc();
        else scrollReaderTocToActive();
      });
    }
  }

  function updateReaderTocToggle() {
    if (!state.root || state.page !== PAGE.READER) return;
    const button = state.root.querySelector('.wrf-toc-toggle');
    if (!button) return;
    const tooltip = state.readerTocOpen ? '收起目录' : '展开目录';
    button.setAttribute('data-tooltip', tooltip);
    button.setAttribute('aria-label', tooltip);
  }

  function refreshReaderMeta() {
    if (!state.root || state.page !== PAGE.READER) return;
    const meta = getReaderMeta();
    const parts = state.root.querySelectorAll('.wrf-breadcrumb .strong');
    if (parts[0] && parts[0].textContent !== meta.book) parts[0].textContent = meta.book;
    if (parts[1] && parts[1].textContent !== meta.chapter) parts[1].textContent = meta.chapter;
    const title = state.root.querySelector('.wrf-article-title');
    if (title && title.textContent !== meta.chapter) title.textContent = meta.chapter;

    if (state.readerTocItems.length) {
      if (ensureActiveTocAncestorsExpanded(state.readerTocItems, meta)) {
        renderShell(true);
        return;
      }
      const activeIndex = findActiveTocIndex(state.readerTocItems, meta);
      state.root.querySelectorAll('.wrf-outline-row').forEach((row) => {
        const index = Number(row.getAttribute('data-toc-index'));
        row.classList.toggle('active', index === activeIndex);
      });
      scrollReaderTocToActive();
    }
  }

  function refreshReaderArticle() {
    if (!state.enabled || !state.root || state.page !== PAGE.READER) return;
    const body = state.root.querySelector('[data-reader-body]');
    if (!(body instanceof HTMLElement)) return;
    const blocks = getReaderBlocks();
    const signature = blocks.map((block) => `${block.type}:${block.text}`).join('|');
    if (!signature || signature === state.readerArticleSignature) return;
    state.readerArticleSignature = signature;
    const main = state.root.querySelector('[data-reader-main]');
    const previousScrollTop = main instanceof HTMLElement ? main.scrollTop : 0;
    body.innerHTML = readerBlocksHtml(blocks);
    if (main instanceof HTMLElement) main.scrollTop = previousScrollTop;

  }

  function refreshHomeData() {
    if (!state.enabled || !state.root || state.page !== PAGE.HOME) return;
    const books = collectHomeBooks();
    const signature = homeDataSignature(books);
    if (signature === state.homeDataSignature) return;
    state.homeDataSignature = signature;
    state.root.innerHTML = `<style>${shellCss}</style>${homeShellHtml(books)}`;
    bindShellEvents();
    queueMicrotask(() => enrichHomeBooks(books));
  }

  function applyPageState(force = false) {
    const nextPage = detectPage();
    const previousPage = state.page;
    const urlChanged = state.lastUrl !== location.href;
    const changed = state.page !== nextPage || urlChanged;
    const nextReaderBookKey = nextPage === PAGE.READER ? getReaderTocStorageKey() : '';
    const readerBookChanged = Boolean(
      nextPage === PAGE.READER &&
      state.readerBookKey &&
      nextReaderBookKey &&
      state.readerBookKey !== nextReaderBookKey
    );

    if (changed && nextPage === PAGE.READER) {
      state.canvasCapture.clear();
      state.readerArticleSignature = '';
      window.clearTimeout(state.readerTocPrimeTimer);
      state.readerTocPrimeAttempts = 0;

      if (previousPage !== PAGE.READER || readerBookChanged) {
        state.readerTocItems = [];
        state.readerOfficialToc = [];
        state.readerOfficialTocPromise = null;
      } else if (state.readerTocItems.length) {
        ensureActiveTocAncestorsExpanded(state.readerTocItems);
      }

      state.readerBookKey = nextReaderBookKey;
    } else if (nextPage !== PAGE.READER) {
      window.clearTimeout(state.readerTocPrimeTimer);
      state.readerTocPrimeAttempts = 0;
      state.readerBookKey = '';
    }

    state.page = nextPage;
    state.lastUrl = location.href;

    document.documentElement.toggleAttribute('data-wrf-page', nextPage !== PAGE.NONE);
    if (nextPage !== PAGE.NONE) {
      document.documentElement.setAttribute('data-wrf-page', nextPage);
    } else {
      document.documentElement.removeAttribute('data-wrf-page');
    }
    document.documentElement.classList.toggle('wrf-enabled', state.enabled && nextPage !== PAGE.NONE);

    if (changed || force) renderShell(true);
    else renderShell(false);
  }

  function setEnabled(enabled) {
    state.enabled = enabled;
    localStorage.setItem(STORAGE_ENABLED, enabled ? '1' : '0');
    document.documentElement.classList.toggle('wrf-enabled', enabled && state.page !== PAGE.NONE);
    renderShell(true);
    if (enabled) toast('已切换到飞书云文档外观');
  }

  function scheduleRefresh() {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      const urlChanged = state.lastUrl !== location.href;
      if (urlChanged) {
        applyPageState(true);
        return;
      }
      if (!state.enabled) return;
      if (state.page === PAGE.READER) {
        refreshReaderMeta();
        refreshReaderArticle();
      } else if (state.page === PAGE.HOME) refreshHomeData();
    }, 140);
  }

  function patchHistory() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (original.__wrfPatched) continue;
      const wrapped = function (...args) {
        const result = original.apply(this, args);
        queueMicrotask(() => applyPageState(true));
        return result;
      };
      wrapped.__wrfPatched = true;
      history[method] = wrapped;
    }
    window.addEventListener('popstate', () => applyPageState(true), { passive: true });
  }

  function observeDom() {
    state.observer?.disconnect();
    state.observer = new MutationObserver(scheduleRefresh);
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function bindKeyboard() {
    window.addEventListener('keydown', (event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setEnabled(!state.enabled);
      }
    }, true);
  }

  function boot() {
    ensureGlobalStyle();
    patchHistory();
    bindKeyboard();
    observeDom();
    applyPageState(true);
    console.info(`[${APP_ID}] v${VERSION} ready. Alt+F toggles the skin.`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
