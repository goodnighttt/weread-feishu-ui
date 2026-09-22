import { canonicalText, cleanText, normalizeUrl, queryByText } from '../core/dom';
import { pageWindow } from '../core/page-window';
import type { BookEntry, ReaderMeta, TocItem } from '../core/types';

const HOME_SECTION_NAMES = [
  '最近热搜', '大家都在看', '大家都在读', '热门推荐', '编辑推荐',
  '飙升榜', '新书榜', '总榜', '热搜榜', '榜单', '我的书架', '最近阅读',
];

export function canonicalBookTitle(value = ''): string {
  return canonicalText(value).replace(/全集|全本|完整版/g, '');
}

function normalizeSectionName(value = ''): string {
  const text = cleanText(value);
  if (!text || text.length > 32) return '';
  if (text.includes('最近热搜')) return '最近热搜';
  if (text.includes('大家都在看') || text.includes('大家都在读')) return '大家都在看';
  if (text.includes('飙升榜')) return '飙升榜';
  if (text.includes('新书榜')) return '新书榜';
  if (text.includes('热搜榜')) return '热搜榜';
  if (text.includes('总榜')) return '总榜';
  if (text === '榜单') return '榜单';
  if (text.includes('我的书架')) return '我的书架';
  if (text.includes('最近阅读')) return '最近阅读';
  if (text.includes('热门推荐')) return '热门推荐';
  if (text.includes('编辑推荐')) return '编辑推荐';
  return HOME_SECTION_NAMES.includes(text) ? text : '';
}

function collectHomeSectionMarkers(): Array<{ node: Element; name: string }> {
  const selectors = [
    'h1', 'h2', 'h3', 'h4', 'h5',
    '[class*="section"] [class*="title"]',
    '[class*="header"] [class*="title"]',
    '[class*="ranking"] [class*="title"]',
    '[class*="rank"] [class*="title"]',
    '[class*="title"]',
  ];
  const seen = new Set<Element>();
  const markers: Array<{ node: Element; name: string }> = [];
  for (const node of document.querySelectorAll(selectors.join(','))) {
    if (seen.has(node)) continue;
    const name = normalizeSectionName(node.textContent || '');
    if (!name) continue;
    seen.add(node);
    markers.push({ node, name });
  }
  return markers;
}

function detectBookSection(anchor: Element, markers: Array<{ node: Element; name: string }>): string {
  let result = '';
  for (const marker of markers) {
    if (marker.node === anchor || marker.node.contains(anchor)) continue;
    if (marker.node.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) result = marker.name;
  }
  if (result) return result;

  let cursor: Element | null = anchor.parentElement;
  for (let depth = 0; depth < 7 && cursor && cursor !== document.body; depth += 1) {
    for (const child of cursor.children) {
      const name = normalizeSectionName(child.textContent || '');
      if (name) return name;
    }
    cursor = cursor.parentElement;
  }
  return '其他';
}

function getBookContainer(anchor: Element): Element {
  let node = anchor;
  for (let i = 0; i < 5 && node.parentElement; i += 1) {
    const parent = node.parentElement;
    const text = cleanText(parent.textContent || '');
    if (text.length > 0 && text.length < 260) node = parent;
    else break;
  }
  return node;
}

function pickText(root: Element, selectors: string[], reject: string[] = []): string {
  for (const selector of selectors) {
    const nodes = root.matches(selector) ? [root] : [...root.querySelectorAll(selector)];
    for (const node of nodes) {
      const value = cleanText(node.textContent || node.getAttribute('title') || node.getAttribute('alt') || '');
      if (!value || value.length > 90) continue;
      if (reject.some((item) => value.includes(item))) continue;
      return value;
    }
  }
  return '';
}

function collectRecentHotSearchEntries(
  sectionMarkers: Array<{ node: Element; name: string }>,
  books: BookEntry[],
): BookEntry[] {
  const marker = sectionMarkers.find((item) => item.name === '最近热搜');
  if (!marker) return [];

  let scope: Element | null = marker.node.parentElement;
  let candidates: Array<{ node: Element; title: string }> = [];
  for (let depth = 0; depth < 5 && scope; depth += 1) {
    candidates = [...scope.querySelectorAll('a, button, [role="button"]')]
      .map((node) => ({ node, title: cleanText(node.textContent || node.getAttribute('title') || '') }))
      .filter((item) => item.title && item.title !== '最近热搜' && item.title.length >= 2 && item.title.length <= 30)
      .filter((item) => !['搜索', '换一批', '登录', '传书到手机', '大家都在看', '大家都在读', '榜单', '飙升榜', '新书榜']
        .some((word) => item.title.includes(word)));
    if (candidates.length >= 2 && candidates.length <= 12) break;
    scope = scope.parentElement;
  }

  const seen = new Set<string>();
  const entries: BookEntry[] = [];
  for (const item of candidates.slice(0, 8)) {
    const key = canonicalBookTitle(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const matched = books.find((book) => {
      const title = canonicalBookTitle(book.title);
      return title === key || title.includes(key) || key.includes(title);
    });
    const rawHref = item.node.getAttribute('href') || '';
    entries.push({
      href: matched?.href || normalizeUrl(rawHref) || `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(item.title)}`,
      title: matched?.title || item.title,
      category: '最近热搜',
      author: matched?.author || '未知作者',
      cover: matched?.cover || '',
    });
  }
  return entries;
}

export function collectHomeBooks(): BookEntry[] {
  const anchors = [...document.querySelectorAll('a[href*="/web/reader/"], a[href*="/web/bookDetail/"]')];
  const markers = collectHomeSectionMarkers();
  const seenLinks = new Set<string>();
  const seenTitles = new Set<string>();
  const books: BookEntry[] = [];
  const titleReject = ['大家都在读', '大家都在看', '榜单', '换一批', '最近热搜', '传书到手机', '登录', '飙升榜', '新书榜'];

  for (const anchor of anchors) {
    const href = normalizeUrl(anchor.getAttribute('href') || (anchor as HTMLAnchorElement).href || '');
    if (!href || seenLinks.has(href)) continue;
    const container = getBookContainer(anchor);
    const img = anchor.querySelector('img') || container.querySelector('img');
    let title = pickText(container, ['[class*="title"]', '[class*="name"]', 'h1', 'h2', 'h3', 'h4'], titleReject);
    if (!title) {
      const direct = cleanText(anchor.textContent || '');
      if (direct && direct.length <= 80 && !titleReject.some((item) => direct.includes(item))) title = direct;
    }
    if (!title && img) title = cleanText(img.getAttribute('alt') || img.getAttribute('title') || '');
    if (!title || title.length < 2) continue;

    const titleKey = canonicalBookTitle(title);
    if (!titleKey || titleReject.some((label) => titleKey === canonicalBookTitle(label)) || seenTitles.has(titleKey)) continue;

    const category = detectBookSection(anchor, markers);
    let author = pickText(container, ['[class*="author"]', '[class*="writer"]'], [title, category]);
    if (!author) {
      const textParts = [...container.querySelectorAll('span, p, div')]
        .map((node) => cleanText(node.textContent || ''))
        .filter((value) => value && value !== title && value !== category && value.length <= 24)
        .filter((value) => !['大家都在读', '大家都在看', '最近热搜', '正在阅读', '推荐值', '换一批', '榜单']
          .some((word) => value.includes(word)));
      author = textParts.find((value) => !/^\d/.test(value) && !normalizeSectionName(value)) || '';
    }

    seenLinks.add(href);
    seenTitles.add(titleKey);
    books.push({ href, title, category, author: author || '未知作者', cover: img?.currentSrc || img?.src || '' });
    if (books.length >= 24) break;
  }

  const hot = collectRecentHotSearchEntries(markers, books);
  const merged = [...hot, ...books];
  const result: BookEntry[] = [];
  const resultKeys = new Set<string>();
  for (const book of merged) {
    const key = canonicalBookTitle(book.title);
    if (!key || resultKeys.has(key)) continue;
    resultKeys.add(key);
    result.push(book);
    if (result.length >= 18) break;
  }
  return result;
}

export function homeDataSignature(books: BookEntry[]): string {
  return books.map((book) => `${book.href}|${book.title}|${book.author}|${book.category}`).join('::');
}

export function parseBookMetadataFromHtml(html = ''): Partial<BookEntry> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const title = cleanText(
    doc.querySelector('.bookInfo_title, [class*="bookInfo_title"], h1')?.textContent ||
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
  );
  const author = cleanText(
    doc.querySelector('.bookInfo_author, [class*="author"]')?.textContent ||
    doc.querySelector('meta[name="author"]')?.getAttribute('content') || '',
  );
  return { title, author };
}

export async function enrichHomeBooks(books: BookEntry[], cache: Map<string, Partial<BookEntry>>): Promise<boolean> {
  const targets = books.filter((book) => !book.author || book.author === '未知作者').slice(0, 8);
  if (!targets.length) return false;
  let changed = false;
  await Promise.all(targets.map(async (book) => {
    const cached = cache.get(book.href);
    if (cached?.author) {
      book.author = cached.author;
      changed = true;
      return;
    }
    try {
      const response = await fetch(book.href, { credentials: 'include' });
      if (!response.ok) return;
      const meta = parseBookMetadataFromHtml(await response.text());
      cache.set(book.href, meta);
      if (meta.author) {
        book.author = meta.author;
        changed = true;
      }
    } catch {
      // Metadata enrichment is optional.
    }
  }));
  return changed;
}

export function getReaderMeta(): ReaderMeta {
  let reader: any = null;
  try { reader = (pageWindow as any).__INITIAL_STATE__?.reader || null; } catch { /* noop */ }
  const textOf = (selectors: string[]): string => {
    for (const selector of selectors) {
      const text = cleanText(document.querySelector(selector)?.textContent || '');
      if (text) return text;
    }
    return '';
  };

  let book = cleanText(reader?.bookInfo?.title || '') || textOf([
    '.readerTopBar_title_link', '.readerTopBar_title', '.bookInfo_title', '[class*="readerTopBar_title"]',
  ]);
  // INITIAL_STATE is a server snapshot and can retain the previous chapter.
  let chapter = textOf([
    '.renderTargetPageInfo_header_chapterTitle',
    '.readerTopBar_title_chapter', '.readerChapterContent_title', '.readerContentHeader_title', '[class*="readerTopBar_title_chapter"]',
  ]);
  let author = cleanText(reader?.bookInfo?.author || '');

  if (!chapter && book && author) {
    const prefix = `${book} - `;
    const suffix = ` - ${author} - 微信读书`;
    if (document.title.startsWith(prefix) && document.title.endsWith(suffix)) {
      chapter = cleanText(document.title.slice(prefix.length, -suffix.length));
    }
  }
  if (!chapter) chapter = cleanText(reader?.currentChapter?.title || '');

  if (!book) {
    const title = document.title.replace(/\s*[-_|｜].*微信读书.*$/i, '').trim();
    if (title && title !== '微信读书') book = title;
  }
  if (!chapter) chapter = '正文';
  if (!book) book = '微信读书';
  if (!author) author = cleanText(document.querySelector('[class*="author"], [class*="writer"]')?.textContent || '');
  return { book, chapter, author: author || '微信读书' };
}

export type NativeAction = 'catalog' | 'note' | 'font';

export function clickNative(action: NativeAction): boolean {
  const configs: Record<NativeAction, { direct: string[]; text: string[] }> = {
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
  const config = configs[action];
  for (const selector of config.direct) {
    const target = document.querySelector(selector);
    if (target instanceof HTMLElement) {
      target.click();
      return true;
    }
  }
  const byText = queryByText(['.readerControls_item', '.readerControls button', 'button', '[role="button"]'], config.text);
  if (byText instanceof HTMLElement) {
    byText.click();
    return true;
  }
  return false;
}

export function clickNativeHomeText(keywords: string[]): boolean {
  const target = [...document.querySelectorAll('a, button, [role="button"]')]
    .find((node) => keywords.some((keyword) => cleanText(node.textContent || '').includes(keyword)));
  if (target instanceof HTMLElement) {
    target.click();
    return true;
  }
  return false;
}

export function getReaderBookId(): string {
  try {
    const fromState = String((pageWindow as any).__INITIAL_STATE__?.reader?.bookInfo?.bookId || '').trim();
    if (fromState) return fromState;
  } catch { /* noop */ }

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || '{}');
      const values = Array.isArray(data) ? data : [data];
      for (const item of values) {
        const raw = item?.bookId ?? item?.['@Id'] ?? item?.['@id'] ?? '';
        const match = String(raw).match(/(?:bookId[=/:])?([A-Za-z0-9_]+)$/);
        if (match?.[1]) return match[1];
      }
    } catch { /* noop */ }
  }

  for (const script of document.scripts) {
    const text = script.textContent || '';
    if (!text.includes('bookId')) continue;
    const match = text.match(/["']bookId["']\s*:\s*["']([^"']+)["']/);
    if (match?.[1]) return match[1];
  }
  return '';
}

export function getReaderBookHash(): string {
  const match = location.pathname.match(/^\/web\/reader\/([^/?#]+)/);
  return match ? match[1].split('k')[0] : '';
}

export function getReaderChapterHash(): string {
  const match = location.pathname.match(/^\/web\/reader\/[^k/?#]+k([^/?#]+)/);
  return match?.[1] || '';
}

export function getCurrentReaderChapterUid(): string {
  const queryUid = new URLSearchParams(location.search).get('progressChapterUid');
  if (queryUid) return queryUid;
  try {
    const chapter = (pageWindow as any).__INITIAL_STATE__?.reader?.currentChapter;
    return String(chapter?.chapterUid ?? chapter?.uid ?? '').trim();
  } catch {
    return '';
  }
}

export function extractChapterUid(node: Element): string {
  const chain = [node, node.closest('[data-chapter-uid], [data-chapteruid], [data-uid]')].filter(Boolean) as Element[];
  for (const el of chain) {
    const value = [el.getAttribute('data-chapter-uid'), el.getAttribute('data-chapteruid'), el.getAttribute('data-uid')]
      .find((item) => item != null && /^\d+$/.test(String(item)));
    if (value != null) return String(value);
  }
  return '';
}

export function getActionHref(node: Element): string {
  const anchor = node.matches('a[href]') ? node : (node.closest('a[href]') || node.querySelector('a[href]'));
  return anchor instanceof HTMLAnchorElement ? normalizeUrl(anchor.getAttribute('href') || anchor.href || '') : '';
}

export function getNativeTocPanel(): Element | null {
  return document.querySelector('.readerCatalog, [class*="readerCatalog"]');
}

export function dispatchNativeClick(node: Element): boolean {
  if (!node.isConnected) return false;
  const target = node.closest('a,button,[role="button"],[class*="item"],[class*="chapter"]') || node;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    try { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: pageWindow })); }
    catch { /* noop */ }
  }
  return true;
}

export function toTocItem(node: Element): TocItem | null {
  const title = cleanText(node.textContent || node.getAttribute('title') || '');
  if (!title || title.length > 120 || ['目录', '关闭', '返回'].includes(title)) return null;
  return {
    title,
    href: getActionHref(node),
    chapterUid: extractChapterUid(node),
    level: 0,
    node,
  };
}
