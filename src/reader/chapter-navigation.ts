import { canonicalBookTitle, clickNative, dispatchNativeClick, getCurrentReaderChapterUid, getReaderBookHash, getReaderChapterHash } from '../adapter/weread';
import { state } from '../core/state';
import type { TocItem } from '../core/types';
import { collectNativeTocItems, fetchOfficialReaderToc } from './toc';

function md5Ascii(input: string): string {
  const rotateLeft = (value: number, shift: number) => (value << shift) | (value >>> (32 - shift));
  const addUnsigned = (x: number, y: number) => {
    const x4 = x & 0x40000000, y4 = y & 0x40000000, x8 = x & 0x80000000, y8 = y & 0x80000000;
    const result = (x & 0x3fffffff) + (y & 0x3fffffff);
    if (x4 & y4) return result ^ 0x80000000 ^ x8 ^ y8;
    if (x4 | y4) return (result & 0x40000000) ? result ^ 0xc0000000 ^ x8 ^ y8 : result ^ 0x40000000 ^ x8 ^ y8;
    return result ^ x8 ^ y8;
  };
  const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
  const G = (x: number, y: number, z: number) => (x & z) | (y & ~z);
  const H = (x: number, y: number, z: number) => x ^ y ^ z;
  const I = (x: number, y: number, z: number) => y ^ (x | ~z);
  const step = (fn: typeof F, a: number, b: number, c: number, d: number, x: number, s: number, ac: number) =>
    addUnsigned(rotateLeft(addUnsigned(a, addUnsigned(addUnsigned(fn(b, c, d), x), ac)), s), b);

  const str = String(input);
  const words: number[] = [];
  let i = 0;
  for (; i < str.length; i += 1) {
    const wordIndex = (i - (i % 4)) / 4;
    const bytePos = (i % 4) * 8;
    words[wordIndex] = (words[wordIndex] || 0) | (str.charCodeAt(i) << bytePos);
  }
  const wordIndex = (i - (i % 4)) / 4;
  const bytePos = (i % 4) * 8;
  words[wordIndex] = (words[wordIndex] || 0) | (0x80 << bytePos);
  const totalWords = (((str.length + 8) >>> 6) + 1) * 16;
  while (words.length < totalWords) words.push(0);
  words[totalWords - 2] = str.length << 3;
  words[totalWords - 1] = str.length >>> 29;

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const S11=7,S12=12,S13=17,S14=22,S21=5,S22=9,S23=14,S24=20,S31=4,S32=11,S33=16,S34=23,S41=6,S42=10,S43=15,S44=21;
  for (let k = 0; k < totalWords; k += 16) {
    const AA=a, BB=b, CC=c, DD=d;
    a=step(F,a,b,c,d,words[k],S11,0xd76aa478); d=step(F,d,a,b,c,words[k+1],S12,0xe8c7b756);
    c=step(F,c,d,a,b,words[k+2],S13,0x242070db); b=step(F,b,c,d,a,words[k+3],S14,0xc1bdceee);
    a=step(F,a,b,c,d,words[k+4],S11,0xf57c0faf); d=step(F,d,a,b,c,words[k+5],S12,0x4787c62a);
    c=step(F,c,d,a,b,words[k+6],S13,0xa8304613); b=step(F,b,c,d,a,words[k+7],S14,0xfd469501);
    a=step(F,a,b,c,d,words[k+8],S11,0x698098d8); d=step(F,d,a,b,c,words[k+9],S12,0x8b44f7af);
    c=step(F,c,d,a,b,words[k+10],S13,0xffff5bb1); b=step(F,b,c,d,a,words[k+11],S14,0x895cd7be);
    a=step(F,a,b,c,d,words[k+12],S11,0x6b901122); d=step(F,d,a,b,c,words[k+13],S12,0xfd987193);
    c=step(F,c,d,a,b,words[k+14],S13,0xa679438e); b=step(F,b,c,d,a,words[k+15],S14,0x49b40821);
    a=step(G,a,b,c,d,words[k+1],S21,0xf61e2562); d=step(G,d,a,b,c,words[k+6],S22,0xc040b340);
    c=step(G,c,d,a,b,words[k+11],S23,0x265e5a51); b=step(G,b,c,d,a,words[k],S24,0xe9b6c7aa);
    a=step(G,a,b,c,d,words[k+5],S21,0xd62f105d); d=step(G,d,a,b,c,words[k+10],S22,0x02441453);
    c=step(G,c,d,a,b,words[k+15],S23,0xd8a1e681); b=step(G,b,c,d,a,words[k+4],S24,0xe7d3fbc8);
    a=step(G,a,b,c,d,words[k+9],S21,0x21e1cde6); d=step(G,d,a,b,c,words[k+14],S22,0xc33707d6);
    c=step(G,c,d,a,b,words[k+3],S23,0xf4d50d87); b=step(G,b,c,d,a,words[k+8],S24,0x455a14ed);
    a=step(G,a,b,c,d,words[k+13],S21,0xa9e3e905); d=step(G,d,a,b,c,words[k+2],S22,0xfcefa3f8);
    c=step(G,c,d,a,b,words[k+7],S23,0x676f02d9); b=step(G,b,c,d,a,words[k+12],S24,0x8d2a4c8a);
    a=step(H,a,b,c,d,words[k+5],S31,0xfffa3942); d=step(H,d,a,b,c,words[k+8],S32,0x8771f681);
    c=step(H,c,d,a,b,words[k+11],S33,0x6d9d6122); b=step(H,b,c,d,a,words[k+14],S34,0xfde5380c);
    a=step(H,a,b,c,d,words[k+1],S31,0xa4beea44); d=step(H,d,a,b,c,words[k+4],S32,0x4bdecfa9);
    c=step(H,c,d,a,b,words[k+7],S33,0xf6bb4b60); b=step(H,b,c,d,a,words[k+10],S34,0xbebfbc70);
    a=step(H,a,b,c,d,words[k+13],S31,0x289b7ec6); d=step(H,d,a,b,c,words[k],S32,0xeaa127fa);
    c=step(H,c,d,a,b,words[k+3],S33,0xd4ef3085); b=step(H,b,c,d,a,words[k+6],S34,0x04881d05);
    a=step(H,a,b,c,d,words[k+9],S31,0xd9d4d039); d=step(H,d,a,b,c,words[k+12],S32,0xe6db99e5);
    c=step(H,c,d,a,b,words[k+15],S33,0x1fa27cf8); b=step(H,b,c,d,a,words[k+2],S34,0xc4ac5665);
    a=step(I,a,b,c,d,words[k],S41,0xf4292244); d=step(I,d,a,b,c,words[k+7],S42,0x432aff97);
    c=step(I,c,d,a,b,words[k+14],S43,0xab9423a7); b=step(I,b,c,d,a,words[k+5],S44,0xfc93a039);
    a=step(I,a,b,c,d,words[k+12],S41,0x655b59c3); d=step(I,d,a,b,c,words[k+3],S42,0x8f0ccc92);
    c=step(I,c,d,a,b,words[k+10],S43,0xffeff47d); b=step(I,b,c,d,a,words[k+1],S44,0x85845dd1);
    a=step(I,a,b,c,d,words[k+8],S41,0x6fa87e4f); d=step(I,d,a,b,c,words[k+15],S42,0xfe2ce6e0);
    c=step(I,c,d,a,b,words[k+6],S43,0xa3014314); b=step(I,b,c,d,a,words[k+13],S44,0x4e0811a1);
    a=step(I,a,b,c,d,words[k+4],S41,0xf7537e82); d=step(I,d,a,b,c,words[k+11],S42,0xbd3af235);
    c=step(I,c,d,a,b,words[k+2],S43,0x2ad7d2bb); b=step(I,b,c,d,a,words[k+9],S44,0xeb86d391);
    a=addUnsigned(a,AA); b=addUnsigned(b,BB); c=addUnsigned(c,CC); d=addUnsigned(d,DD);
  }
  const hex = (value: number) => {
    let out = '';
    for (let j=0;j<=3;j+=1) out += (`0${((value >>> (j*8)) & 255).toString(16)}`).slice(-2);
    return out;
  };
  return `${hex(a)}${hex(b)}${hex(c)}${hex(d)}`.toLowerCase();
}

export function wereadEncodeId(value: string | number): string {
  const text = String(value ?? '');
  if (!text) return '';
  const hash = md5Ascii(text);
  let result = hash.slice(0, 3);
  let chunks: string[];
  let typeFlag: string;
  if (/^\d+$/.test(text)) {
    chunks = (text.match(/.{1,9}/g) || []).map((part) => Number(part).toString(16));
    typeFlag = '3';
  } else {
    chunks = [Array.from(text).map((char) => char.charCodeAt(0).toString(16)).join('')];
    typeFlag = '4';
  }
  result += `${typeFlag}2${hash.slice(-2)}`;
  result += chunks.map((chunk) => `${chunk.length.toString(16).padStart(2, '0')}${chunk}`).join('g');
  if (result.length < 20) result += hash.slice(0, 20 - result.length);
  result += md5Ascii(result).slice(0, 3);
  return result;
}

export function buildReaderChapterUrl(chapterUid: string): string {
  const uid = String(chapterUid || '').trim();
  const bookHash = getReaderBookHash();
  const chapterHash = wereadEncodeId(uid);
  if (!uid || !bookHash || !chapterHash) return '';
  return `${location.origin}/web/reader/${bookHash}k${chapterHash}`;
}

export function resolveCurrentReaderChapterUid(items: TocItem[] = state.readerTocItems): string {
  const direct = getCurrentReaderChapterUid();
  if (direct) return direct;
  const hash = getReaderChapterHash();
  if (!hash) return '';
  const matched = items.find((item) => item.chapterUid && wereadEncodeId(item.chapterUid) === hash);
  return String(matched?.chapterUid || '');
}

function findLiveNativeTocItem(index: number, title: string): TocItem | null {
  const live = collectNativeTocItems();
  const wanted = canonicalBookTitle(title);
  const indexed = Number.isInteger(index) ? live[index] : undefined;
  if (indexed && (!wanted || canonicalBookTitle(indexed.title) === wanted)) return indexed;
  return live.find((item) => canonicalBookTitle(item.title) === wanted) || null;
}

export async function navigateToReaderTocItem(index: number, title: string): Promise<boolean> {
  const saved = state.readerTocItems[index] || null;
  if (saved?.href) {
    location.assign(saved.href);
    return true;
  }
  if (saved?.chapterUid) {
    const url = buildReaderChapterUrl(saved.chapterUid);
    if (url) {
      location.assign(url);
      return true;
    }
  }

  const official = await fetchOfficialReaderToc();
  const wanted = canonicalBookTitle(title || saved?.title || '');
  let chapter = official.find((item) => canonicalBookTitle(item.title) === wanted);
  if (!chapter && Number.isInteger(index)) chapter = official[index];
  if (chapter?.chapterUid) {
    const url = buildReaderChapterUrl(chapter.chapterUid);
    if (url) {
      location.assign(url);
      return true;
    }
  }

  const clickLive = () => {
    const item = findLiveNativeTocItem(index, title || saved?.title || '');
    if (!item) return false;
    if (item.href) {
      location.assign(item.href);
      return true;
    }
    if (item.chapterUid) {
      const url = buildReaderChapterUrl(item.chapterUid);
      if (url) {
        location.assign(url);
        return true;
      }
    }
    return item.node ? dispatchNativeClick(item.node) : false;
  };

  if (clickLive()) return true;
  if (clickNative('catalog')) {
    await new Promise((resolve) => window.setTimeout(resolve, 140));
    return clickLive();
  }
  return false;
}
