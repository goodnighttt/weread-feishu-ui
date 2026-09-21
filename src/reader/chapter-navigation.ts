import {
  canonicalBookTitle,
  clickNative,
  getCurrentReaderChapterUid,
  getNativeTocPanel,
  getReaderBookHash,
  getReaderBookId,
  getReaderMeta,
} from '../adapter/weread';
import { state } from '../core/state';
import type { TocItem } from '../core/types';

const NAV_LOG = '[微信读书·飞书UI][目录跳转]';

let publicCatalogBookId = '';
let publicCatalogCache: TocItem[] = [];
let publicCatalogPromise: Promise<TocItem[]> | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
  if (exact.length) return exact;

  return [...panel.querySelectorAll('.readerCatalog_list_item')];
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
  // 微信读书当前目录的点击区域在 item 内部；从标题文字节点发出 click，
  // 事件会向上冒泡到 Vue/React 绑定的目录项处理器。直接点外层 div 可能没有任何效果。
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
    if (
      currentChapter
      && canonicalBookTitle(currentChapter) !== canonicalBookTitle(args.beforeChapter)
    ) return true;

    if (args.row.classList.contains('readerCatalog_list_item_selected')) return true;
  }
  return false;
}

function extractPublicChapters(payload: any): TocItem[] {
  const candidates = [
    payload?.data?.[0]?.updated,
    payload?.data?.[0]?.chapters,
    payload?.data?.updated,
    payload?.data?.chapters,
    payload?.updated,
    payload?.chapters,
  ];
  const chapters = candidates.find(Array.isArray) || [];

  return chapters
    .map((chapter: any) => {
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
        locked: Number.isFinite(price) && price > 0 && paid !== 1,
        lockSource: 'official' as const,
      } satisfies TocItem;
    })
    .filter((item: TocItem) => item.title && item.chapterUid);
}

async function fetchPublicCatalog(): Promise<TocItem[]> {
  const bookId = getReaderBookId();
  if (!bookId) return [];
  if (publicCatalogBookId === bookId && publicCatalogCache.length) return publicCatalogCache;
  if (publicCatalogBookId === bookId && publicCatalogPromise) return publicCatalogPromise;

  publicCatalogBookId = bookId;
  publicCatalogPromise = fetch('/web/book/publicchapterInfos', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ bookIds: [String(bookId)] }),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      publicCatalogCache = extractPublicChapters(payload);
      return publicCatalogCache;
    })
    .catch(() => {
      publicCatalogCache = [];
      return [];
    })
    .finally(() => {
      publicCatalogPromise = null;
    });

  return publicCatalogPromise;
}

function findCatalogItem(items: TocItem[], index: number, title: string): TocItem | null {
  const wanted = canonicalBookTitle(title);
  const indexed = Number.isInteger(index) ? items[index] : undefined;
  if (indexed && (!wanted || canonicalBookTitle(indexed.title) === wanted)) return indexed;
  return items.find((item) => canonicalBookTitle(item.title) === wanted) || null;
}

function enrichStateFromPublicCatalog(publicItems: TocItem[]): void {
  if (!publicItems.length || !state.readerTocItems.length) return;
  const byTitle = new Map(publicItems.map((item) => [canonicalBookTitle(item.title), item]));
  state.readerTocItems = state.readerTocItems.map((item) => {
    const match = byTitle.get(canonicalBookTitle(item.title));
    if (!match) return item;
    return {
      ...item,
      chapterUid: item.chapterUid || match.chapterUid,
      chapterIdx: item.chapterIdx ?? match.chapterIdx,
      price: item.price ?? match.price,
      paid: item.paid ?? match.paid,
      // 原生目录已经能准确反映当前账号是否可读，不用公开接口覆盖它。
      locked: item.locked ?? match.locked,
      lockSource: item.lockSource || match.lockSource,
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

function outputNavigationLog(
  level: 'info' | 'warn' | 'error',
  data: Record<string, unknown>,
): void {
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
  const trace: Record<string, unknown> = {
    '章节': wantedTitle,
    '目录序号': index,
    '当前地址': beforeHref,
    '当前章节': beforeChapter,
    '书籍ID': getReaderBookId(),
    '书籍哈希': getReaderBookHash(),
    '初始章节UID': targetUid || '未取得',
    '原生目录已打开': isNativeCatalogOpen(),
  };

  if (!saved) {
    trace['结果'] = '失败：飞书目录中没有对应章节';
    outputNavigationLog('error', trace);
    return false;
  }

  if (saved.locked) {
    trace['结果'] = '已阻止：该章节当前处于锁定状态';
    trace['锁定来源'] = saved.lockSource || '未知';
    trace['价格'] = saved.price;
    trace['已购买'] = saved.paid;
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
  if (nativeRow) {
    trace['原生目录标题'] = nativeRowTitle(nativeRow);
    trace['原生目录锁定'] = isNativeRowLocked(nativeRow);

    if (!isNativeRowLocked(nativeRow)) {
      const clicked = clickNativeCatalogRow(nativeRow);
      trace['原生点击'] = clicked ? '已触发' : '触发失败';
      if (clicked) {
        const navigated = await waitForNativeNavigation({
          beforeHref,
          beforeUid,
          beforeChapter,
          row: nativeRow,
          targetUid,
        });
        if (navigated) {
          trace['结果'] = '成功：通过微信读书原生目录跳转';
          trace['跳转后地址'] = location.href;
          trace['跳转后章节'] = getReaderMeta().chapter;
          outputNavigationLog('info', trace);
          return true;
        }
      }
    }
  }

  // 原生 DOM 不暴露 chapterUid；匿名网页则可能让 /chapterInfos 返回空数组。
  // 因此在这里使用微信读书公开目录接口补齐 UID，再走官方支持的 progressChapterUid 链接。
  let catalogSource = '现有目录数据';
  let matched = findCatalogItem(state.readerOfficialToc, index, wantedTitle);
  if (matched?.chapterUid) targetUid = String(matched.chapterUid);

  if (!targetUid) {
    const publicItems = await fetchPublicCatalog();
    trace['公开目录章节数'] = publicItems.length;
    matched = findCatalogItem(publicItems, index, wantedTitle);
    if (matched?.chapterUid) {
      targetUid = String(matched.chapterUid);
      catalogSource = '公开目录接口';
      enrichStateFromPublicCatalog(publicItems);
    }
  }

  trace['章节UID来源'] = catalogSource;
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

  trace['结果'] = '失败：没有取得可用的章节UID，原生目录点击也未生效';
  outputNavigationLog('error', trace);
  return false;
}
