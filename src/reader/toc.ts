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
  if (!panel) return [];
  const candidates = [...panel.querySelectorAll('a, button, [role="button"], [class*="item"], [class*="chapter"]')];
  const seen = new Set<string>();
  const items: TocItem[] = [];
  for (const node of candidates) {
    const title = cleanText(node.textContent || node.getAttribute('title') || '');
    if (!title || title.length > 120 || ['目录', '关闭', '返回'].includes(title)) continue;
    const key = canonicalBookTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const dataLevel = [node.getAttribute('data-level'), node.getAttribute('data-depth'), node.getAttribute('data-indent')]
      .map(Number).find(Number.isFinite);
    items.push({
      title,
      href: getActionHref(node),
      chapterUid: extractChapterUid(node),
      level: Number.isFinite(dataLevel) ? Number(dataLevel) : 0,
      rawIndent: getNativeTocRawIndent(node),
      node,
    });
    if (items.length >= 300) break;
  }
  return normalizeTocLevels(items);
}

export async function fetchOfficialReaderToc(): Promise<TocItem[]> {
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
    .then((payload: any) => {
      const records = Array.isArray(payload?.data) ? payload.data : [];
      const record = records[0] || payload?.data || payload || {};
      const chapters = record?.updated || record?.chapters || payload?.updated || payload?.chapters || [];
      const items: TocItem[] = Array.isArray(chapters)
        ? chapters.map((chapter: any) => {
            const rawLevel = [chapter?.level, chapter?.depth, chapter?.indent, chapter?.chapterLevel, chapter?.hierarchy]
              .map(Number).find(Number.isFinite);
            return {
              title: cleanText(chapter?.title || ''),
              chapterUid: String(chapter?.chapterUid ?? ''),
              chapterIdx: Number(chapter?.chapterIdx ?? -1),
              level: Number.isFinite(rawLevel) ? Number(rawLevel) : 0,
            } satisfies TocItem;
          }).filter((chapter: TocItem) => chapter.title && chapter.chapterUid)
        : [];
      state.readerOfficialToc = normalizeTocLevels(items);
      return state.readerOfficialToc;
    })
    .catch((error) => {
      console.warn('[wr-feishu-ui] chapter catalog fetch failed', error);
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
    return match ? { ...item, level: match.level, chapterUid: item.chapterUid || match.chapterUid } : item;
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

  const official = await fetchOfficialReaderToc();
  if (official.length) {
    state.readerTocItems = official;
    ensureActiveTocAncestorsExpanded(state.readerTocItems);
    onUpdated?.();
    scrollReaderTocToActive();
    return;
  }

  const existing = collectNativeTocItems();
  if (existing.length) {
    state.readerTocItems = existing;
    ensureActiveTocAncestorsExpanded(state.readerTocItems);
    onUpdated?.();
    const enriched = await fetchOfficialReaderToc();
    if (enriched.length) state.readerTocItems = mergeTocLevelsFromOfficial(state.readerTocItems, enriched);
    onUpdated?.();
    scrollReaderTocToActive();
    return;
  }

  if (!clickNative('catalog')) return;
  await new Promise((resolve) => window.setTimeout(resolve, 180));
  const items = collectNativeTocItems();
  clickNative('catalog');
  if (items.length) {
    state.readerTocItems = items;
    ensureActiveTocAncestorsExpanded(items);
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
