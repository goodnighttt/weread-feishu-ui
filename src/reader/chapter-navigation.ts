import {
  canonicalBookTitle,
  clickNative,
  dispatchNativeClick,
  getCurrentReaderChapterUid,
  getReaderBookHash,
} from '../adapter/weread';
import { state } from '../core/state';
import type { TocItem } from '../core/types';
import { collectNativeTocItems, fetchOfficialReaderToc } from './toc';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function buildReaderChapterUrl(chapterUid: string): string {
  const uid = String(chapterUid || '').trim();
  const bookHash = getReaderBookHash();
  if (!uid || !bookHash) return '';
  const url = new URL(`${location.origin}/web/reader/${bookHash}`);
  url.searchParams.set('progressChapterUid', uid);
  return url.href;
}

export function resolveCurrentReaderChapterUid(): string {
  return getCurrentReaderChapterUid();
}

function findLiveNativeTocItem(index: number, title: string): TocItem | null {
  const live = collectNativeTocItems();
  const wanted = canonicalBookTitle(title);
  const indexed = Number.isInteger(index) ? live[index] : undefined;
  if (indexed && (!wanted || canonicalBookTitle(indexed.title) === wanted)) return indexed;
  return live.find((item) => canonicalBookTitle(item.title) === wanted) || null;
}

function isUsableReaderHref(href = ''): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, location.href);
    return url.origin === location.origin && url.pathname.startsWith('/web/reader/') && url.href !== location.href;
  } catch {
    return false;
  }
}

async function tryNativeNavigation(index: number, title: string, targetUid = ''): Promise<boolean> {
  const item = findLiveNativeTocItem(index, title);
  if (!item?.node) return false;

  const beforeHref = location.href;
  const beforeUid = getCurrentReaderChapterUid();
  dispatchNativeClick(item.node);
  await wait(220);

  if (location.href !== beforeHref) return true;
  const currentUid = getCurrentReaderChapterUid();
  const wantedUid = String(targetUid || item.chapterUid || '').trim();
  if (wantedUid && currentUid === wantedUid) return true;
  return Boolean(currentUid && currentUid !== beforeUid);
}

export async function navigateToReaderTocItem(index: number, title: string): Promise<boolean> {
  const saved = state.readerTocItems[index] || null;
  const wantedTitle = title || saved?.title || '';
  let targetUid = String(saved?.chapterUid || '').trim();

  // Let WeRead handle the chapter switch itself whenever its live catalog DOM is available.
  if (await tryNativeNavigation(index, wantedTitle, targetUid)) return true;

  if (clickNative('catalog')) {
    await wait(180);
    if (await tryNativeNavigation(index, wantedTitle, targetUid)) return true;
  }

  // Fall back to the official catalog to obtain a stable chapterUid.
  const official = await fetchOfficialReaderToc();
  const wanted = canonicalBookTitle(wantedTitle);
  let chapter = official.find((item) => canonicalBookTitle(item.title) === wanted);
  if (!chapter && Number.isInteger(index)) chapter = official[index];
  if (!targetUid && chapter?.chapterUid) targetUid = String(chapter.chapterUid);

  // WeRead accepts the raw chapterUid through progressChapterUid; this avoids relying on
  // a locally reimplemented private ID encoder for navigation.
  if (targetUid) {
    const url = buildReaderChapterUrl(targetUid);
    if (url) {
      location.assign(url);
      return true;
    }
  }

  // Native controls sometimes expose # / javascript: pseudo-links, so only trust real reader URLs.
  const href = saved?.href || chapter?.href || '';
  if (isUsableReaderHref(href)) {
    location.assign(href);
    return true;
  }

  const live = findLiveNativeTocItem(index, wantedTitle);
  if (live?.href && isUsableReaderHref(live.href)) {
    location.assign(live.href);
    return true;
  }
  return false;
}
