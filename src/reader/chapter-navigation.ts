import { getCurrentReaderChapterUid, getNativeTocPanel, getReaderMeta, extractChapterUid } from '../adapter/weread';
import { cleanText } from '../core/dom';
import { state } from '../core/state';

const NAV_LOG = '[微信读书·飞书UI][目录跳转]';
const PANEL = 'data-wrf-native-hit-panel';
const ROW = 'data-wrf-native-hit';
const PATH = 'data-wrf-native-hit-path';
const rectProperties = ['--wrf-hit-left', '--wrf-hit-top', '--wrf-hit-width', '--wrf-hit-height'];
const marked = new Set<HTMLElement>();
const trackedRows = new WeakSet<HTMLElement>();
const boundRoots = new WeakSet<ShadowRoot>();
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let observedOutline: HTMLElement | null = null;
let windowEventsBound = false;
let navigationId = 0;

function nativeTitle(row: Element): string {
  return cleanText(row.querySelector('.readerCatalog_list_item_title_text')?.textContent || row.getAttribute('title') || '');
}

function mark(element: HTMLElement, attribute: string, value = '1'): void {
  if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
  marked.add(element);
}

function unmark(element: HTMLElement): void {
  element.removeAttribute(PANEL);
  element.removeAttribute(ROW);
  element.removeAttribute(PATH);
  rectProperties.forEach(property => element.style.removeProperty(property));
  marked.delete(element);
}

export function clearNativeTocHitTargets(): void {
  cancelAnimationFrame(frame);
  frame = 0;
  [...marked].forEach(unmark);
  resizeObserver?.disconnect();
  observedOutline = null;
}

function recordNativeClick(row: HTMLElement): void {
  if (trackedRows.has(row)) return;
  trackedRows.add(row);
  row.addEventListener('click', event => {
    if (!row.hasAttribute(ROW) || !event.isTrusted) return;
    const title = nativeTitle(row);
    const beforeHref = location.href;
    const id = ++navigationId;
    console.info(`${NAV_LOG} 原生目录收到真实点击`, { 章节: title, isTrusted: event.isTrusted });
    const started = performance.now();
    const check = () => {
      if (id !== navigationId || !state.enabled || state.page !== 'reader') return;
      // A selected class or an unrelated URL change is not chapter confirmation.
      if (location.href !== beforeHref && getReaderMeta().chapter === title) {
        console.info(`${NAV_LOG} 已确认目标章节`, { 章节: title, 地址: location.href });
        syncNativeTocHitTargets();
      } else if (performance.now() - started < 8000) {
        window.setTimeout(check, 150);
      } else {
        console.warn(`${NAV_LOG} 尚未确认目标章节，请检查原生阅读页的登录或购买提示`, { 章节: title });
      }
    };
    window.setTimeout(check, 150);
  }, { capture: true });
  row.addEventListener('wheel', event => {
    if (!row.hasAttribute(ROW) || !observedOutline) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? observedOutline.clientHeight : 1;
    observedOutline.scrollTop += event.deltaY * scale;
    updateHitTargets();
  }, { passive: false });
}

function updateHitTargets(): void {
  frame = 0;
  const outline = state.root?.querySelector<HTMLElement>('.wrf-reader-outline');
  if (!state.enabled || state.page !== 'reader' || !state.readerTocOpen || !outline?.isConnected || outline.classList.contains('hidden')) {
    clearNativeTocHitTargets();
    return;
  }
  if (observedOutline !== outline) {
    resizeObserver?.disconnect();
    observedOutline = outline;
    resizeObserver ??= new ResizeObserver(syncNativeTocHitTargets);
    resizeObserver.observe(outline);
  }
  const panel = getNativeTocPanel();
  if (!(panel instanceof HTMLElement)) { [...marked].forEach(unmark); return; }
  const rows = [...panel.querySelectorAll<HTMLElement>('.readerCatalog_list_item')];
  const byTitle = new Map<string, HTMLElement[]>();
  const byUid = new Map<string, HTMLElement[]>();
  for (const row of rows) {
    const title = nativeTitle(row);
    if (title) byTitle.set(title, [...(byTitle.get(title) || []), row]);
    const uid = extractChapterUid(row);
    if (uid) byUid.set(uid, [...(byUid.get(uid) || []), row]);
  }
  const keep = new Set<HTMLElement>();
  const bounds = outline.getBoundingClientRect();
  for (const visual of outline.querySelectorAll<HTMLElement>('.wrf-outline-item')) {
    const item = state.readerTocItems[Number(visual.dataset.tocIndex)];
    if (!item || item.locked) continue;
    const candidates = (item.chapterUid && byUid.get(String(item.chapterUid))) || byTitle.get(cleanText(item.title)) || [];
    // Without a native UID, only a unique exact title is safe. Never guess by index.
    if (candidates.length !== 1) continue;
    const row = candidates[0];
    if (!row.querySelector('.readerCatalog_list_item_inner')) continue;
    const rect = visual.getBoundingClientRect();
    const left = Math.max(rect.left, bounds.left, 0);
    const top = Math.max(rect.top, bounds.top, 0);
    const right = Math.min(rect.right, bounds.right, innerWidth);
    const bottom = Math.min(rect.bottom, bounds.bottom, innerHeight);
    if (right <= left || bottom <= top) continue;
    mark(panel, PANEL);
    keep.add(panel);
    // Leave Vue's DOM ownership intact; remove clipping only along the row's path.
    for (let parent = row.parentElement; parent && parent !== panel; parent = parent.parentElement) {
      mark(parent, PATH);
      keep.add(parent);
    }
    mark(row, ROW, visual.dataset.tocIndex);
    keep.add(row);
    [left, top, right - left, bottom - top].forEach((value, index) => {
      const text = `${value}px`;
      if (row.style.getPropertyValue(rectProperties[index]) !== text) row.style.setProperty(rectProperties[index], text);
    });
    recordNativeClick(row);
  }
  for (const element of [...marked]) if (!keep.has(element)) unmark(element);
}

export function syncNativeTocHitTargets(): void {
  if (!windowEventsBound) {
    windowEventsBound = true;
    window.addEventListener('resize', syncNativeTocHitTargets, { passive: true });
    window.addEventListener('scroll', syncNativeTocHitTargets, { passive: true, capture: true });
  }
  if (state.root && !boundRoots.has(state.root)) {
    boundRoots.add(state.root);
    state.root.addEventListener('scroll', updateHitTargets, { passive: true, capture: true });
  }
  if (!frame) frame = requestAnimationFrame(updateHitTargets);
}

export function resolveCurrentReaderChapterUid(items = state.readerTocItems): string {
  const title = getReaderMeta().chapter;
  const matches = items.filter(item => item.title === title && item.chapterUid);
  return matches.length === 1 ? String(matches[0].chapterUid) : getCurrentReaderChapterUid();
}

// Only reached when the original hit target is unavailable, or from a keyboard.
export async function navigateToReaderTocItem(index: number, title: string): Promise<boolean> {
  syncNativeTocHitTargets();
  console.warn(`${NAV_LOG} 未命中原生目录，请切回原界面使用目录`, { 章节: title, 目录序号: index });
  return false;
}
