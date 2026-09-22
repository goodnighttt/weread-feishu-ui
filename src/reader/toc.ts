import {
  canonicalBookTitle,
  clickNative,
  extractChapterUid,
  getActionHref,
  getNativeTocPanel,
  getReaderBookHash,
  getReaderBookId,
  getReaderMeta,
} from '../adapter/weread';
import { cleanText, nextFrame } from '../core/dom';
import { state } from '../core/state';
import { STORAGE, writeBoolean, writeJson } from '../core/storage';
import type { TocItem } from '../core/types';
import { resolveCurrentReaderChapterUid } from './chapter-navigation';

const TOC_LOG = '[wr-feishu-ui][toc]';

function isTocVolumeTitle(title = ''): boolean {
  return /^(第[一二三四五六七八九十百千万零〇0-9]+[卷部篇辑册编]|卷[一二三四五六七八九十百千万零〇0-9]+|part\s*[ivx0-9]+)/i.test(cleanText(title));
}

function isTocChapterTitle(title = ''): boolean {
  return /^(第[一二三四五六七八九十百千万零〇0-9]+章|chapter\s*\d+)/i.test(cleanText(title));
}

function isTocFrontMatterTitle(title = ''): boolean {
  return /^(序章|序言|前言|楔子|引子|版权信息|版权声明|书籍封面|封面|目录|后记|附录|跋|致谢)/.test(cleanText(title));
}

function isTocSubsectionTitle(title = ''): boolean {
  return /^(\d+(?:\.\d+)+|[一二三四五六七八九十]+、|\([一二三四五六七八九十0-9]+\)|（[一二三四五六七八九十0-9]+）|第[一二三四五六七八九十百千万零〇0-9]+[节小节])/.test(cleanText(title));
}

function inferTocLevelFromTitle(title = '', context: { hasVolume?: boolean; seenChapter?: boolean; currentChapterLevel?: number } = {}): number {
  const text = cleanText(title);
  if (!text) return 0;
  if (isTocFrontMatterTitle(text) || isTocVolumeTitle(text)) return 0;
  if (isTocChapterTitle(text)) return context.hasVolume ? 1 : 0;
  if (isTocSubsectionTitle(text)) return Math.min(4, (context.currentChapterLevel ?? (context.hasVolume ? 1 : 0)) + 1);
  if (context.seenChapter) return Math.min(4, (context.currentChapterLevel ?? 0) + 1);
  return 0;
}

function getNativeTocRawIndent(node: Element): number {
  const target = node.closest('a,button,[role="button"],[class*="item"],[class*="chapter"]') || node;
  try {
    const style = getComputedStyle(target);
    return Math.max(0, (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.marginLeft) || 0));
  } catch {
    return 0;
  }
}

function isNativeTocLocked(node: Element): boolean {
  const row = node.closest('li,[class*="chapter"],[class*="item"]') || node;
  if (row.matches('[disabled],[aria-disabled="true"],[data-locked="1"],[data-lock="1"]')) return true;
  if (row.querySelector('[class*="lock"],[class*="Lock"],[aria-label*="锁"],[title*="锁"]')) return true;

  const classText = [row, ...Array.from(row.querySelectorAll('[class]')).slice(0, 24)]
    .map((item) => item.getAttribute('class') || '')
    .join(' ')
    .toLowerCase();
  if (/(^|[\s_-])locked?([\s_-]|$)/.test(classText)) return true;

  const hint = cleanText(`${row.getAttribute('aria-label') || ''} ${row.getAttribute('title') || ''}`);
  return /锁定|未购买|需购买|付费章节/.test(hint);
}

export function normalizeTocLevels(items: TocItem[]): TocItem[] {
  if (!items.length) return items;
  const explicitValues = items.filter((item) => Number.isFinite(item.level)).map((item) => item.level);
  const distinctExplicit = [...new Set(explicitValues)];
  const explicitUseful = distinctExplicit.length > 1;
  const explicitMin = explicitUseful ? Math.min(...explicitValues) : 0;
  const indents = [...new Set(items.map((item) => Math.round(item.rawIndent || 0)).filter((value) => value > 0))].sort((a, b) => a - b);
  const hasVolume = items.some((item) => isTocVolumeTitle(item.title));
  let seenChapter = false;
  let currentChapterLevel = hasVolume ? 1 : 0;

  return items.map((item) => {
    let level: number | null = explicitUseful ? item.level - explicitMin : null;
    if (level == null && (item.rawIndent || 0) > 0 && indents.length > 1) {
      let nearestIndex = 0;
      let nearestDistance = Infinity;
      indents.forEach((value, index) => {
        const distance = Math.abs(value - (item.rawIndent || 0));
        if (distance < nearestDistance) {
          nearestIndex = index;
          nearestDistance = distance;
        }
      });
      level = nearestIndex;
    }
    if (level == null) {
      if (isTocChapterTitle(item.title)) {
        seenChapter = true;
        currentChapterLevel = hasVolume ? 1 : 0;
      }
      level = inferTocLevelFromTitle(item.title, { hasVolume, seenChapter, currentChapterLevel });
    }
    return { ...item, level: Math.max(0, Math.min(4, Number(level) || 0)) };
  });
}

export function collectNativeTocItems(): TocItem[] {
  const panel = getNativeTocPanel();
  if (!panel) {
    console.info(`${TOC_LOG} native catalog panel not found`);
    return [];
  }

  const candidates = [...panel.querySelectorAll('.readerCatalog_list_item')];
  const seen = new Set<string>();
  const items: TocItem[] = [];
  for (const node of candidates) {
    const title = cleanText(node.querySelector('.readerCatalog_list_item_title_text')?.textContent || node.getAttribute('title') || '');
    if (!title || title.length > 120 || ['目录', '关闭', '返回'].includes(title)) continue;
    const key = canonicalBookTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const nativeLevel = node.querySelector('.readerCatalog_list_item_inner')?.className.match(/readerCatalog_list_item_level_(\d+)/)?.[1];
    const dataLevel = [node.getAttribute('data-level'), node.getAttribute('data-depth'), nativeLevel]
      .filter(value => value != null).map(Number).find(Number.isFinite);
    const locked = isNativeTocLocked(node);
    items.push({
      title,
      href: getActionHref(node),
      chapterUid: extractChapterUid(node),
      level: Number.isFinite(dataLevel) ? Number(dataLevel) : 0,
      rawIndent: getNativeTocRawIndent(node),
      node,
      locked,
      lockSource: locked ? 'native' : undefined,
    });
    if (items.length >= 300) break;
  }

  console.info(`${TOC_LOG} native catalog collected`, {
    count: items.length,
    locked: items.filter((item) => item.locked).length,
    withUid: items.filter((item) => item.chapterUid).length,
    withHref: items.filter((item) => item.href).length,
  });
  return normalizeTocLevels(items);
}

export async function fetchOfficialReaderToc(): Promise<TocItem[]> {
  if (state.readerOfficialToc.length) return state.readerOfficialToc;
  if (state.readerOfficialTocPromise) return state.readerOfficialTocPromise;
  const bookId = getReaderBookId();
  if (!bookId) {
    console.warn(`${TOC_LOG} cannot request chapterInfos: bookId not found`, {
      href: location.href,
      bookHash: getReaderBookHash(),
      meta: getReaderMeta(),
    });
    return [];
  }

  console.info(`${TOC_LOG} requesting chapterInfos`, { bookId });
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
    .then((payload: any) => {
      const records = Array.isArray(payload?.data) ? payload.data : [];
      const record = records[0] || payload?.data || payload || {};
      const chapters = record?.updated || record?.chapters || payload?.updated || payload?.chapters || [];
      const items: TocItem[] = Array.isArray(chapters)
        ? chapters.map((chapter: any) => {
            const rawLevel = [chapter?.level, chapter?.depth, chapter?.indent, chapter?.chapterLevel, chapter?.hierarchy]
              .map(Number).find(Number.isFinite);
            const price = Number(chapter?.price ?? 0);
            const paid = Number(chapter?.paid ?? 0);
            const locked = Number.isFinite(price) && price > 0 && paid !== 1;
            return {
              title: cleanText(chapter?.title || ''),
              chapterUid: String(chapter?.chapterUid ?? ''),
              chapterIdx: Number(chapter?.chapterIdx ?? -1),
              level: Number.isFinite(rawLevel) ? Number(rawLevel) : 0,
              price: Number.isFinite(price) ? price : 0,
              paid: Number.isFinite(paid) ? paid : 0,
              locked,
              lockSource: locked ? 'official' : undefined,
            } satisfies TocItem;
          }).filter((chapter: TocItem) => chapter.title && chapter.chapterUid)
        : [];
      state.readerOfficialToc = normalizeTocLevels(items);
      console.info(`${TOC_LOG} chapterInfos ready`, {
        bookId,
        count: state.readerOfficialToc.length,
        locked: state.readerOfficialToc.filter((item) => item.locked).length,
        first: state.readerOfficialToc.slice(0, 3).map((item) => ({
          title: item.title,
          chapterUid: item.chapterUid,
          price: item.price,
          paid: item.paid,
          locked: item.locked,
        })),
      });
      return state.readerOfficialToc;
    })
    .catch((error) => {
      console.warn(`${TOC_LOG} chapterInfos failed`, error);
      return [];
    })
    .finally(() => {
      state.readerOfficialTocPromise = null;
    });
  return state.readerOfficialTocPromise;
}

export function mergeTocLevelsFromOfficial(items: TocItem[], official: TocItem[]): TocItem[] {
  if (!items.length || !official.length) return items;
  const byUid = new Map(official.filter((item) => item.chapterUid).map((item) => [String(item.chapterUid), item]));
  const byTitle = new Map(official.map((item) => [canonicalBookTitle(item.title), item]));
  return normalizeTocLevels(items.map((item) => {
    const match = byUid.get(String(item.chapterUid || '')) || byTitle.get(canonicalBookTitle(item.title));
    if (!match) return item;
    return {
      ...item,
      level: match.level,
      chapterUid: item.chapterUid || match.chapterUid,
      chapterIdx: item.chapterIdx ?? match.chapterIdx,
      price: match.price,
      paid: match.paid,
      locked: Boolean(item.locked || match.locked),
      lockSource: item.locked ? item.lockSource : match.lockSource,
    };
  }));
}

export function getReaderTocStorageKey(): string {
  const hash = getReaderBookHash();
  if (hash) return `hash:${hash}`;
  const bookId = getReaderBookId();
  if (bookId) return `id:${bookId}`;
  const title = canonicalBookTitle(getReaderMeta().book);
  return title ? `title:${title}` : 'unknown';
}

export function tocItemStableKey(item: TocItem, index: number): string {
  return item.chapterUid
    ? `uid:${item.chapterUid}`
    : `title:${canonicalBookTitle(item.title)}|level:${item.level}|index:${index}`;
}

export function getReaderCollapsedTocSet(): Set<string> {
  const values = state.readerTocCollapsedByBook[getReaderTocStorageKey()];
  return new Set(Array.isArray(values) ? values : []);
}

function saveReaderCollapsedTocSet(collapsed: Set<string>): void {
  state.readerTocCollapsedByBook[getReaderTocStorageKey()] = [...collapsed];
  writeJson(STORAGE.readerTocCollapsed, state.readerTocCollapsedByBook);
}

export function setReaderTocOpen(open: boolean): void {
  state.readerTocOpen = open;
  writeBoolean(STORAGE.readerTocOpen, open);
}

export function findActiveTocIndex(items: TocItem[], meta = getReaderMeta()): number {
  const currentUid = resolveCurrentReaderChapterUid(items);
  if (currentUid) {
    const byUid = items.findIndex((item) => String(item.chapterUid || '') === currentUid);
    if (byUid >= 0) return byUid;
  }
  const wanted = canonicalBookTitle(meta.chapter);
  return wanted ? items.findIndex((item) => canonicalBookTitle(item.title) === wanted) : -1;
}

export function hasTocChildren(items: TocItem[], index: number): boolean {
  if (index >= items.length - 1) return false;
  return (items[index + 1]?.level || 0) > (items[index]?.level || 0);
}

export function ensureActiveTocAncestorsExpanded(items: TocItem[], meta = getReaderMeta()): boolean {
  const activeIndex = findActiveTocIndex(items, meta);
  if (activeIndex <= 0) return false;
  const collapsed = getReaderCollapsedTocSet();
  let level = items[activeIndex]?.level || 0;
  let changed = false;
  for (let index = activeIndex - 1; index >= 0 && level > 0; index -= 1) {
    const parentLevel = items[index]?.level || 0;
    if (parentLevel >= level) continue;
    if (collapsed.delete(tocItemStableKey(items[index], index))) changed = true;
    level = parentLevel;
  }
  if (changed) saveReaderCollapsedTocSet(collapsed);
  return changed;
}

export function toggleReaderTocGroup(index: number): void {
  const items = state.readerTocItems;
  if (!items[index] || !hasTocChildren(items, index)) return;
  const collapsed = getReaderCollapsedTocSet();
  const key = tocItemStableKey(items[index], index);
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  saveReaderCollapsedTocSet(collapsed);
}

export function scrollReaderTocToActive(behavior: ScrollBehavior = 'auto'): void {
  if (!state.readerTocOpen || !state.root) return;
  nextFrame(() => {
    const outline = state.root?.querySelector('.wrf-reader-outline');
    const active = state.root?.querySelector('.wrf-outline-row.active');
    if (!(outline instanceof HTMLElement) || !(active instanceof HTMLElement)) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top >= outline.scrollTop + 24 && bottom <= outline.scrollTop + outline.clientHeight - 24) return;
    outline.scrollTo({ top: Math.max(0, top - outline.clientHeight * 0.38), behavior });
  });
}

export async function primeReaderToc(onUpdated?: () => void): Promise<void> {
  if (state.readerTocItems.length) {
    ensureActiveTocAncestorsExpanded(state.readerTocItems);
    onUpdated?.();
    scrollReaderTocToActive();
    return;
  }

  // The native rows are already rendered, including current access state.
  // Show them immediately instead of waiting on an authenticated API request.
  const existing = collectNativeTocItems();
  if (existing.length) {
    state.readerTocItems = existing;
    ensureActiveTocAncestorsExpanded(state.readerTocItems);
    console.info(`${TOC_LOG} using native catalog already in DOM`, { count: existing.length });
    onUpdated?.();
    scrollReaderTocToActive();
    return;
  }

  const official = await fetchOfficialReaderToc();
  if (!state.enabled || state.page !== 'reader') return;
  if (official.length) {
    state.readerTocItems = official;
    ensureActiveTocAncestorsExpanded(state.readerTocItems);
    onUpdated?.();
    scrollReaderTocToActive();
    return;
  }

  const opened = clickNative('catalog');
  console.info(`${TOC_LOG} opening native catalog for discovery`, { opened });
  if (!opened) return;
  await new Promise((resolve) => window.setTimeout(resolve, 220));
  const items = collectNativeTocItems();
  clickNative('catalog');
  if (items.length) {
    state.readerTocItems = items;
    ensureActiveTocAncestorsExpanded(items);
    console.info(`${TOC_LOG} using native catalog after opening`, { count: items.length });
    onUpdated?.();
    scrollReaderTocToActive();
  }
}

export function scheduleReaderTocPrimeRetry(onUpdated?: () => void): void {
  window.clearTimeout(state.readerTocPrimeTimer);
  if (!state.enabled || state.page !== 'reader' || state.readerTocItems.length || state.readerTocPrimeAttempts >= 8) return;
  state.readerTocPrimeTimer = window.setTimeout(async () => {
    state.readerTocPrimeAttempts += 1;
    await primeReaderToc(onUpdated);
    if (!state.readerTocItems.length) scheduleReaderTocPrimeRetry(onUpdated);
  }, Math.min(1200, 160 + state.readerTocPrimeAttempts * 130));
}
