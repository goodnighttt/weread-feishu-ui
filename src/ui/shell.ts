import { state } from '../core/state';
import nativeCss from '../styles/native.css?inline';
import tokensCss from '../styles/tokens.css?inline';
import commonCss from '../styles/common.css?inline';
import homeCss from '../styles/home.css?inline';
import readerCss from '../styles/reader.css?inline';
import tocCss from '../styles/toc.css?inline';

const HOST_ID = 'wr-feishu-ui-host';
const STYLE_ID = 'wr-feishu-ui-global-style';

export const shellCss = [tokensCss, commonCss, homeCss, readerCss, tocCss].join('\n');

export function ensureGlobalStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = nativeCss;
  (document.head || document.documentElement).appendChild(style);
}

export function ensureHost(): ShadowRoot {
  if (state.root && state.host?.isConnected) return state.root;
  let host = document.getElementById(HOST_ID) as HTMLDivElement | null;
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;z-index:1000000;pointer-events:none;';
    (document.body || document.documentElement).appendChild(host);
  }
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  state.host = host;
  state.root = root;
  return root;
}

export function setShellHtml(html: string): void {
  const root = ensureHost();
  root.innerHTML = `<style>${shellCss}</style>${html}`;
}

export function hideHost(): void {
  if (state.host) state.host.style.display = 'none';
}

export function showHost(): void {
  if (state.host) state.host.style.display = '';
}

export function toast(message: string): void {
  if (!state.root) return;
  state.root.querySelector('.wrf-toast')?.remove();
  const element = document.createElement('div');
  element.className = 'wrf-toast';
  element.textContent = message;
  state.root.appendChild(element);
  window.setTimeout(() => element.remove(), 1800);
}
