import { collectHomeBooks, enrichHomeBooks, homeDataSignature } from '../adapter/weread';
import { state } from '../core/state';
import { STORAGE, writeJson } from '../core/storage';
import type { BookEntry } from '../core/types';
import { homeViewHtml } from '../ui/home-view';
import { setShellHtml } from '../ui/shell';

function updatePinnedBooks(books: BookEntry[]): void {
  const seen = new Set<string>();
  const pinned = books.filter((book) => book.category === '最近热搜' || book.category === '大家都在看')
    .filter((book) => {
      const key = book.title.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
  if (!pinned.length) return;
  state.pinnedBooks = pinned;
  writeJson(STORAGE.pinnedBooks, pinned);
}

export function renderHome(version: string): BookEntry[] {
  const books = collectHomeBooks();
  state.homeDataSignature = homeDataSignature(books);
  updatePinnedBooks(books);
  setShellHtml(homeViewHtml(books, state.pinnedBooks, version));
  return books;
}

export async function enrichAndRefreshHome(version: string, books: BookEntry[]): Promise<boolean> {
  const changed = await enrichHomeBooks(books, state.metadataCache);
  if (!changed || !state.enabled || state.page !== 'home') return false;
  state.homeDataSignature = homeDataSignature(books);
  updatePinnedBooks(books);
  setShellHtml(homeViewHtml(books, state.pinnedBooks, version));
  return true;
}

export function refreshHome(version: string): BookEntry[] | null {
  if (!state.enabled || state.page !== 'home') return null;
  const books = collectHomeBooks();
  const signature = homeDataSignature(books);
  if (signature === state.homeDataSignature) return null;
  state.homeDataSignature = signature;
  updatePinnedBooks(books);
  setShellHtml(homeViewHtml(books, state.pinnedBooks, version));
  return books;
}
