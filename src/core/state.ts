import type { AppState } from './types';
import { migrateReaderTocDefaultOpen, readBoolean, readCollapsedToc, readPinnedBooks, STORAGE } from './storage';

export const state: AppState = {
  enabled: readBoolean(STORAGE.enabled, true),
  page: 'none',
  lastUrl: location.href,
  observer: null,
  refreshTimer: 0,
  host: null,
  root: null,
  shellMarker: '',
  homeDataSignature: '',
  readerTocOpen: migrateReaderTocDefaultOpen(),
  readerTocItems: [],
  readerOfficialToc: [],
  readerOfficialTocPromise: null,
  readerArticleSignature: '',
  readerBookKey: '',
  readerTocPrimeTimer: 0,
  readerTocPrimeAttempts: 0,
  metadataCache: new Map(),
  canvasCapture: new Map(),
  canvasRefreshTimer: 0,
  pinnedBooks: readPinnedBooks(),
  readerTocCollapsedByBook: readCollapsedToc(),
};
