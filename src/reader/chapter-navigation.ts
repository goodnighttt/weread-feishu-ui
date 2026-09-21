import {
  canonicalBookTitle,
  clickNative,
  dispatchNativeClick,
  getCurrentReaderChapterUid,
  getNativeTocPanel,
  getReaderBookHash,
} from '../adapter/weread';
import { state } from '../core/state';
import type { TocItem } from '../core/types';
import { collectNativeTocItems, fetchOfficialReaderToc } from './toc';

const NAV_LOG = '[wr-feishu-ui][toc-nav]';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function buildReaderChapterUrl(chapterUid: string): string {
  const uid = String(chapterUid || '').trim();
  const bookHash = getReaderBookHash();
  if (!uid || !bookHash) {
    console.warn(`${NAV_LOG} cannot build reader URL`, { uid, bookHash, href: location.href });
    return '';
  }
  const url = new URL(`${location.origin}/web/reader/${bookHash}`);
  url.searchParams.set('progressChapterUid', uid);
  return url.href;
}

export function resolveCurrentReaderChapterUid(_items: TocItem[] = state.readerTocItems): string {
  return getCurrentReaderChapterUid();
}

function findLiveNativeTocItem(index: number, title: string): TocItem | null {
  const live = collectNativeTocItems();
  const wanted = canonicalBookTitle(title);
  const indexed = Number.isInteger(index) ? live[index] : undefined;
  if (indexed && (!wanted || canonicalBookTitle(indexed.title) === wanted)) return indexed;
  return live.find((item) => canonicalBookTitle(item.title) === wanted) || null;
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

function isUsableReaderHref(href = ''): boolean {
  if (!href) return false;
  try {
    const url = new URL(href, location.href);
    return url.origin === location.origin && url.pathname.startsWith('/web/reader/') && url.href !== location.href;
  } catch {
    return false;
  }
}

function clickNativeTocNode(node: Element): boolean {
  const target = node.matches('a[href],button,[role="button"]')
    ? node
    : (node.querySelector('a[href],button,[role="button"]') || node);
  if (target instanceof HTMLElement) {
    try {
      target.click();
      return true;
    } catch (error) {
      console.warn(`${NAV_LOG} HTMLElement.click failed`, error);
    }
  }
  return dispatchNativeClick(target);
}

async function tryNativeNavigation(index: number, title: string, targetUid = ''): Promise<boolean> {
  const item = findLiveNativeTocItem(index, title);
  if (!item?.node) {
    console.info(`${NAV_LOG} native item not found`, { index, title, targetUid });
    return false;
  }
  if (item.locked) {
    console.warn(`${NAV_LOG} native item is locked`, { index, title, targetUid, item });
    return false;
  }

  const beforeHref = location.href;
  const beforeUid = getCurrentReaderChapterUid();
  const clicked = clickNativeTocNode(item.node);
  console.info(`${NAV_LOG} native click dispatched`, {
    index,
    title,
    targetUid,
    clicked,
    nativeHref: item.href,
    nativeUid: item.chapterUid,
    beforeHref,
    beforeUid,
  });
  if (!clicked) return false;

  await wait(320);
  if (location.href !== beforeHref) {
    console.info(`${NAV_LOG} native navigation changed URL`, { from: beforeHref, to: location.href });
    return true;
  }

  const currentUid = getCurrentReaderChapterUid();
  const wantedUid = String(targetUid || item.chapterUid || '').trim();
  if (wantedUid && currentUid === wantedUid) {
    console.info(`${NAV_LOG} native navigation changed chapterUid`, { currentUid });
    return true;
  }
  if (currentUid && currentUid !== beforeUid) {
    console.info(`${NAV_LOG} native navigation changed current chapter`, { beforeUid, currentUid });
    return true;
  }

  console.warn(`${NAV_LOG} native click produced no navigation`, {
    index,
    title,
    targetUid,
    currentHref: location.href,
    beforeUid,
    currentUid,
  });
  return false;
}

export async function navigateToReaderTocItem(index: number, title: string): Promise<boolean> {
  const saved = state.readerTocItems[index] || null;
  const wantedTitle = title || saved?.title || '';
  let targetUid = String(saved?.chapterUid || '').trim();

  console.info(`${NAV_LOG} click`, {
    index,
    title: wantedTitle,
    saved: saved ? {
      chapterUid: saved.chapterUid,
      chapterIdx: saved.chapterIdx,
      href: saved.href,
      locked: saved.locked,
      price: saved.price,
      paid: saved.paid,
      lockSource: saved.lockSource,
    } : null,
    href: location.href,
    bookHash: getReaderBookHash(),
    currentUid: getCurrentReaderChapterUid(),
    nativeCatalogOpen: isNativeCatalogOpen(),
  });

  if (!saved) {
    console.warn(`${NAV_LOG} state item missing`, { index, title: wantedTitle, count: state.readerTocItems.length });
  } else if (saved.locked) {
    console.warn(`${NAV_LOG} blocked locked chapter`, {
      index,
      title: wantedTitle,
      chapterUid: saved.chapterUid,
      price: saved.price,
      paid: saved.paid,
      source: saved.lockSource,
    });
    return false;
  }

  if (isNativeCatalogOpen()) {
    if (await tryNativeNavigation(index, wantedTitle, targetUid)) return true;
  } else {
    const opened = clickNative('catalog');
    console.info(`${NAV_LOG} requested native catalog open`, { opened });
    if (opened) {
      await wait(260);
      console.info(`${NAV_LOG} native catalog after open`, {
        open: isNativeCatalogOpen(),
        panelFound: Boolean(getNativeTocPanel()),
      });
      if (await tryNativeNavigation(index, wantedTitle, targetUid)) return true;
    }
  }

  const official = await fetchOfficialReaderToc();
  const wanted = canonicalBookTitle(wantedTitle);
  let chapter = official.find((item) => canonicalBookTitle(item.title) === wanted);
  if (!chapter && Number.isInteger(index)) chapter = official[index];
  if (!targetUid && chapter?.chapterUid) targetUid = String(chapter.chapterUid);

  console.info(`${NAV_LOG} official fallback`, {
    officialCount: official.length,
    matched: chapter ? {
      title: chapter.title,
      chapterUid: chapter.chapterUid,
      chapterIdx: chapter.chapterIdx,
      locked: chapter.locked,
      price: chapter.price,
      paid: chapter.paid,
    } : null,
    targetUid,
  });

  if (chapter?.locked) {
    console.warn(`${NAV_LOG} official catalog marks chapter locked`, {
      title: chapter.title,
      chapterUid: chapter.chapterUid,
      price: chapter.price,
      paid: chapter.paid,
    });
    return false;
  }

  if (targetUid) {
    const url = buildReaderChapterUrl(targetUid);
    if (url) {
      console.info(`${NAV_LOG} navigating with progressChapterUid`, { url, targetUid });
      location.assign(url);
      return true;
    }
  }

  const href = saved?.href || chapter?.href || '';
  if (isUsableReaderHref(href)) {
    console.info(`${NAV_LOG} navigating with saved href`, { href });
    location.assign(href);
    return true;
  }

  const live = findLiveNativeTocItem(index, wantedTitle);
  if (live?.locked) {
    console.warn(`${NAV_LOG} final native lookup is locked`, { index, title: wantedTitle });
    return false;
  }
  if (live?.href && isUsableReaderHref(live.href)) {
    console.info(`${NAV_LOG} navigating with live native href`, { href: live.href });
    location.assign(live.href);
    return true;
  }

  console.error(`${NAV_LOG} navigation failed`, {
    index,
    title: wantedTitle,
    targetUid,
    saved,
    officialCount: official.length,
    live: live ? {
      title: live.title,
      chapterUid: live.chapterUid,
      href: live.href,
      locked: live.locked,
    } : null,
    href: location.href,
    bookHash: getReaderBookHash(),
  });
  return false;
}
