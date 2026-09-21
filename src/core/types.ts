export type PageKind = 'home' | 'reader' | 'none';

export interface BookEntry {
  href: string;
  title: string;
  author: string;
  category: string;
  cover?: string;
}

export type ReaderBlockType = 'p' | 'h2' | 'h3' | 'quote' | 'code';

export interface ReaderBlock {
  type: ReaderBlockType;
  text: string;
}

export interface ReaderMeta {
  book: string;
  chapter: string;
  author: string;
}

export interface TocItem {
  title: string;
  href?: string;
  chapterUid?: string;
  chapterIdx?: number;
  level: number;
  rawIndent?: number;
  node?: Element | null;
  active?: boolean;
}

export interface CanvasRecord {
  text: string;
  x: number;
  y: number;
  font: string;
  scale: number;
  align: string;
  width: number;
}

export interface CanvasBucket {
  records: Map<string, CanvasRecord>;
  updatedAt: number;
}

export interface AppState {
  enabled: boolean;
  page: PageKind;
  lastUrl: string;
  observer: MutationObserver | null;
  refreshTimer: number;
  host: HTMLDivElement | null;
  root: ShadowRoot | null;
  shellMarker: string;
  homeDataSignature: string;
  readerTocOpen: boolean;
  readerTocItems: TocItem[];
  readerOfficialToc: TocItem[];
  readerOfficialTocPromise: Promise<TocItem[]> | null;
  readerArticleSignature: string;
  readerBookKey: string;
  readerTocPrimeTimer: number;
  readerTocPrimeAttempts: number;
  metadataCache: Map<string, Partial<BookEntry>>;
  canvasCapture: Map<HTMLCanvasElement, CanvasBucket>;
  canvasRefreshTimer: number;
  pinnedBooks: BookEntry[];
  readerTocCollapsedByBook: Record<string, string[]>;
}
