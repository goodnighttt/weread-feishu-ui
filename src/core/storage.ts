import type { BookEntry } from './types';

export const STORAGE = {
  enabled: 'wr-feishu-ui:enabled',
  pinnedBooks: 'wr-feishu-ui:pinned-books',
  readerTocOpen: 'wr-feishu-ui:reader-toc-open',
  readerTocCollapsed: 'wr-feishu-ui:reader-toc-collapsed',
  readerTocMigration: 'wr-feishu-ui:reader-toc-v2',
} as const;

export function readBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  if (value == null) return fallback;
  return value === '1';
}

export function writeBoolean(key: string, value: boolean): void {
  localStorage.setItem(key, value ? '1' : '0');
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota/privacy failures. UI state persistence is non-critical.
  }
}

export function migrateReaderTocDefaultOpen(): boolean {
  if (localStorage.getItem(STORAGE.readerTocMigration) !== '1') {
    localStorage.setItem(STORAGE.readerTocMigration, '1');
    writeBoolean(STORAGE.readerTocOpen, true);
    return true;
  }
  return readBoolean(STORAGE.readerTocOpen, true);
}

export function readPinnedBooks(): BookEntry[] {
  return readJson<BookEntry[]>(STORAGE.pinnedBooks, []);
}

export function readCollapsedToc(): Record<string, string[]> {
  return readJson<Record<string, string[]>>(STORAGE.readerTocCollapsed, {});
}
