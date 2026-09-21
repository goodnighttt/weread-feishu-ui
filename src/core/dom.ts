export function cleanText(value = ''): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function escapeHtml(value = ''): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function normalizeUrl(value = ''): string {
  try {
    return new URL(value, location.origin).href;
  } catch {
    return '';
  }
}

export function canonicalText(value = ''): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\s·•—–_\-:：，,。.!！?？'"“”‘’（）()【】\[\]<>《》]/g, '');
}

export function queryByText(selectors: string[], keywords: string[]): Element | null {
  const nodes = [...document.querySelectorAll(selectors.join(','))];
  return nodes.find((node) => {
    const text = `${node.textContent || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('aria-label') || ''}`;
    return keywords.some((key) => text.includes(key));
  }) || null;
}

export function isHTMLElement(value: unknown): value is HTMLElement {
  return value instanceof HTMLElement;
}

export function nextFrame(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}
