import {
  canonicalBookTitle,
  clickNative,
  getCurrentReaderChapterUid,
  getNativeTocPanel,
  getReaderBookHash,
  getReaderMeta,
} from '../adapter/weread';
import { pageWindow } from '../core/page-window';
import { state } from '../core/state';
import type { TocItem } from '../core/types';

const NAV_LOG = '[微信读书·飞书UI][目录跳转]';

let catalogCacheKey = '';
let catalogCache: TocItem[] = [];
let catalogSelectedBookId = '';
let catalogPromise: Promise<TocItem[]> | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeBookIdCandidate(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/(?:bookId[=/:])?([A-Za-z0-9_]+)\/?$/);
  return match?.[1] || '';
}

function collectReaderBookIdCandidates(): string[] {
  const ids: string[] = [];
  const push = (value: unknown) => {
    const id = normalizeBookIdCandidate(value);
    if (id && !ids.includes(id)) ids.push(id);
  };

  // 匿名阅读页上，LD+JSON 的 @Id 通常比运行时 state 里的 bookId 更适合目录接口。
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || '{}');
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        push(value?.bookId);
        push(value?.['@Id']);
        push(value?.['@id']);
      }
    } catch { /* 忽略无效 JSON */ }
  }

  try {
    const reader = (pageWindow as any).__INITIAL_STATE__?.reader;
    push(reader?.bookInfo?.bookId);
    push(reader?.bookId);
  } catch { /* 忽略 */ }

  // 最后再从内联脚本中补充候选，避免页面结构变化时完全拿不到 ID。
  for (const script of document.scripts) {
    const text = script.textContent || '';
    const patterns = [
      /["']bookId["']\s*:\s*["']([^"']+)["']/g,
      /["']@Id["']\s*:\s*["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) != null && ids.length < 8) push(match[1]);
    }
    if (ids.length >= 8) break;
  }
  return ids;
}

function nativeRowTitle(row: Element): string {
  return String(
    row.querySelector('.readerCatalog_list_item_title_text')?.textContent
    || row.getAttribute('title')
    || row.textContent
    || '',
  ).replace(/\s+/g, ' ').trim();
}

function getNativeCatalogRows(): Element[] {
  const panel = getNativeTocPanel();
  if (!panel) return [];
  const exact = [...panel.querySelectorAll('.readerCatalog_list > .readerCatalog_list_item')];
  return exact.length ? exact : [...panel.querySelectorAll('.readerCatalog_list_item')];
}

function findNativeCatalogRow(index: number, title: string): Element | null {
  const rows = getNativeCatalogRows();
  const wanted = canonicalBookTitle(title);
  const indexed = Number.isInteger(index) ? rows[index] : undefined;
  if (indexed && (!wanted || canonicalBookTitle(nativeRowTitle(indexed)) === wanted)) return indexed;
  return rows.find((row) => canonicalBookTitle(nativeRowTitle(row)) === wanted) || null;
}

function isNativeRowLocked(row: Element): boolean {
  if (row.matches('[disabled],[aria-disabled="true"],[data-locked="1"],[data-lock="1"]')) return true;
  if (row.querySelector('[class*="lock"],[class*="Lock"],[aria-label*="锁"],[title*="锁"]')) return true;
  const text = `${row.getAttribute('class') || ''} ${row.getAttribute('aria-label') || ''} ${row.getAttribute('title') || ''}`;
  return /(?:^|[\s_-])locked?(?:[\s_-]|$)|锁定|未购买|需购买|付费章节/i.test(text);
}

function isNativeCatalogOpen(): boolean {
  const panel = getNativeTocPanel();
  if (!(panel instanceof HTMLElement)) return false;
  try {
    const style = getComputedStyle(panel);
    return style.display !== 'none' && style.visibility !== 'hidden' && panel.getClientRects().length > 0;
  } catch {
    return panel.getClientRects().length > 0;
  }
}

function clickNativeCatalogRow(row: Element): boolean {
  const target = row.querySelector<HTMLElement>('.readerCatalog_list_item_title_text')
    || row.querySelector<HTMLElement>('.readerCatalog_list_item_inner')
    || (row instanceof HTMLElement ? row : null);
  if (!target) return false;
  try {
    target.click();
    return true;
  } catch {
    return false;
  }
}

async function waitForNativeNavigation(args: {
  beforeHref: string;
  beforeUid: string;
  beforeChapter: string;
  row: Element;
  targetUid: string;
}): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < 1200) {
    await wait(80);
    if (location.href !== args.beforeHref) return true;
    const currentUid = getCurrentReaderChapterUid();
    if (args.targetUid && currentUid === args.targetUid) return true;
    if (currentUid && currentUid !== args.beforeUid) return true;
    const currentChapter = getReaderMeta().chapter;
    if (currentChapter && canonicalBookTitle(currentChapter) !== canonicalBookTitle(args.beforeChapter)) return true;
    if (args.row.classList.contains('readerCatalog_list_item_selected')) return true;
  }
  return false;
}

function chaptersFromRecord(record: any): TocItem[] {
  const chapters = Array.isArray(record?.updated)
    ? record.updated
    : (Array.isArray(record?.chapters) ? record.chapters : []);
  return chapters.map((chapter: any) => {
    const title = String(chapter?.title || '').replace(/\s+/g, ' ').trim();
    const chapterUid = String(chapter?.chapterUid ?? '').trim();
    const price = Number(chapter?.price ?? 0);
    const paid = Number(chapter?.paid ?? 0);
    const rawLevel = Number(chapter?.level ?? 0);
    return {
      title,
      chapterUid,
      chapterIdx: Number(chapter?.chapterIdx ?? -1),
      level: Number.isFinite(rawLevel) ? rawLevel : 0,
      price: Number.isFinite(price) ? price : 0,
      paid: Number.isFinite(paid) ? paid : 0,
    } satisfies TocItem;
  }).filter((item: TocItem) => item.title && item.chapterUid);
}

function chooseCatalogRecord(payload: any): { items: TocItem[]; bookId: string } {
  const records = Array.isArray(payload?.data)
    ? payload.data
    : (payload?.data ? [payload.data] : [payload]);
  const wantedBook = canonicalBookTitle(getReaderMeta().book);
  const usable = records.map((record: any) => ({
    record,
    items: chaptersFromRecord(record),
    title: canonicalBookTitle(record?.book?.title || record?.title || ''),
  })).filter((entry) => entry.items.length > 0);
  if (!usable.length) return { items: [], bookId: '' };
  const matched = usable.find((entry) => entry.title && wantedBook && entry.title === wantedBook) || usable[0];
  return {
    items: matched.items,
    bookId: normalizeBookIdCandidate(matched.record?.bookId || matched.record?.book?.bookId),
  };
}

async function requestCatalog(endpoint: string, bookIds: string[]): Promise<{ items: TocItem[]; bookId: string }> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ bookIds }),
    });
    if (!response.ok) return { items: [], bookId: '' };
    return chooseCatalogRecord(await response.json());
  } catch {
    return { items: [], bookId: '' };
  }
}

async function fetchFallbackCatalog(): Promise<TocItem[]> {
  const ids = collectReaderBookIdCandidates();
  const key = ids.join('|');
  if (!ids.length) return [];
  if (catalogCacheKey === key && catalogCache.length) return catalogCache;
  if (catalogCacheKey === key && catalogPromise) return catalogPromise;

  catalogCacheKey = key;
  catalogPromise = (async () => {
    // 未登录优先公开目录；登录态或个别书公开目录为空时再回退普通目录。
    let result = await requestCatalog('/web/book/publicchapterInfos', ids);
    if (!result.items.length) result = await requestCatalog('/web/book/chapterInfos', ids);
    catalogCache = result.items;
    catalogSelectedBookId = result.bookId;
    return catalogCache;
  })().finally(() => {
    catalogPromise = null;
  });
  return catalogPromise;
}

function findCatalogItem(items: TocItem[], index: number, title: string): TocItem | null {
  const wanted = canonicalBookTitle(title);
  const byTitle = items.find((item) => canonicalBookTitle(item.title) === wanted);
  if (byTitle) return byTitle;
  const indexed = Number.isInteger(index) ? items[index] : undefined;
  return indexed || null;
}

function enrichStateFromCatalog(items: TocItem[]): void {
  if (!items.length || !state.readerTocItems.length) return;
  const byTitle = new Map(items.map((item) => [canonicalBookTitle(item.title), item]));
  state.readerTocItems = state.readerTocItems.map((item) => {
    const match = byTitle.get(canonicalBookTitle(item.title));
    if (!match) return item;
    return {
      ...item,
      chapterUid: item.chapterUid || match.chapterUid,
      chapterIdx: item.chapterIdx ?? match.chapterIdx,
      price: item.price ?? match.price,
      paid: item.paid ?? match.paid,
    };
  });
}

export function buildReaderChapterUrl(chapterUid: string): string {
  const uid = String(chapterUid || '').trim();
  const bookHash = getReaderBookHash();
  if (!uid || !bookHash) return '';
  const url = new URL(`${location.origin}/web/reader/${bookHash}`);
  url.searchParams.set('progressChapterUid', uid);
  return url.href;
}

export function resolveCurrentReaderChapterUid(_items: TocItem[] = state.readerTocItems): string {
  return getCurrentReaderChapterUid();
}

function outputNavigationLog(level: 'info' | 'warn' | 'error', data: Record<string, unknown>): void {
  const message = `${NAV_LOG} ${String(data['结果'] || '完成')}`;
  if (level === 'error') console.error(message, data);
  else if (level === 'warn') console.warn(message, data);
  else console.info(message, data);
}

export async function navigateToReaderTocItem(index: number, title: string): Promise<boolean> {
  const saved = state.readerTocItems[index] || null;
  const wantedTitle = title || saved?.title || '';
  let targetUid = String(saved?.chapterUid || '').trim();
  const beforeHref = location.href;
  const beforeUid = getCurrentReaderChapterUid();
  const beforeChapter = getReaderMeta().chapter;
  const bookIdCandidates = collectReaderBookIdCandidates();
  const trace: Record<string, unknown> = {
    '章节': wantedTitle,
    '目录序号': index,
    '当前章节': beforeChapter,
    '书籍ID候选': bookIdCandidates.length ? bookIdCandidates : '未取得',
    '书籍哈希': getReaderBookHash(),
    '初始章节UID': targetUid || '未取得',
  };

  if (!saved) {
    trace['结果'] = '失败：飞书目录中没有对应章节';
    outputNavigationLog('error', trace);
    return false;
  }
  if (saved.locked) {
    trace['结果'] = '已阻止：该章节当前处于锁定状态';
    trace['锁定来源'] = saved.lockSource || '原生目录';
    outputNavigationLog('warn', trace);
    return false;
  }

  if (!isNativeCatalogOpen()) {
    const opened = clickNative('catalog');
    trace['尝试打开原生目录'] = opened;
    if (opened) await wait(260);
  }

  const nativeRow = findNativeCatalogRow(index, wantedTitle);
  trace['原生目录项'] = nativeRow ? '已找到' : '未找到';
  if (nativeRow && !isNativeRowLocked(nativeRow)) {
    const clicked = clickNativeCatalogRow(nativeRow);
    trace['原生点击'] = clicked ? '已触发' : '触发失败';
    if (clicked && await waitForNativeNavigation({ beforeHref, beforeUid, beforeChapter, row: nativeRow, targetUid })) {
      trace['结果'] = '成功：通过微信读书原生目录跳转';
      trace['跳转后章节'] = getReaderMeta().chapter;
      outputNavigationLog('info', trace);
      return true;
    }
  }

  let matched = findCatalogItem(state.readerOfficialToc, index, wantedTitle);
  if (matched?.chapterUid) targetUid = String(matched.chapterUid);

  if (!targetUid) {
    const fallbackItems = await fetchFallbackCatalog();
    trace['接口目录章节数'] = fallbackItems.length;
    trace['接口命中的书籍ID'] = catalogSelectedBookId || '未命中';
    matched = findCatalogItem(fallbackItems, index, wantedTitle);
    if (matched?.chapterUid) {
      targetUid = String(matched.chapterUid);
      enrichStateFromCatalog(fallbackItems);
    }
  }

  trace['最终章节UID'] = targetUid || '未取得';
  if (targetUid) {
    const url = buildReaderChapterUrl(targetUid);
    if (url) {
      trace['结果'] = '已发起：通过章节UID直达';
      trace['目标地址'] = url;
      outputNavigationLog('info', trace);
      location.assign(url);
      return true;
    }
  }

  trace['结果'] = '失败：目录接口与原生目录都没有提供可用的章节跳转信息';
  outputNavigationLog('error', trace);
  return false;
}
