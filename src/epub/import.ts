/**
 * 导入：EPUB 字节 → 解析 → 写进 Dexie（books / chapters / paras / progress）。
 * 书 id = 原始文件的 sha256（hex），同一个文件重复导入不会多一份，只把它切成"当前书"。
 */
import type { ReaderDB } from '../db/db';
import type { Book } from '../types';
import { parseEpub, type ParsedBook, type ProgressFn } from './parse';

export interface ImportResult {
  bookId: string;
  title: string;
  /** 这个文件以前导入过（没重新解析） */
  existed: boolean;
  chapters: number;
  paras: number;
  words: number;
  /** 段落少于 50：导入了，但提示一句"可能加密了" */
  fewParas: boolean;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function importEpub(d: ReaderDB, bytes: Uint8Array, onProgress?: ProgressFn): Promise<ImportResult> {
  const bookId = await sha256Hex(bytes);
  const old = await d.books.get(bookId);
  if (old) {
    const chapters = await d.chapters.where('bookId').equals(bookId).count();
    const paras = await d.paras.where('bookId').equals(bookId).count();
    await touchProgress(d, bookId);
    return { bookId, title: old.title, existed: true, chapters, paras, words: 0, fewParas: false };
  }

  const parsed = await parseEpub(bytes, onProgress);
  await onProgress?.('save', 0, 1);
  await saveParsed(d, bookId, parsed);
  await onProgress?.('save', 1, 1);
  return {
    bookId,
    title: parsed.title,
    existed: false,
    chapters: parsed.chapters.length,
    paras: parsed.paras.length,
    words: parsed.words,
    fewParas: parsed.fewParas,
  };
}

export async function saveParsed(d: ReaderDB, bookId: string, p: ParsedBook): Promise<void> {
  const book: Book = { id: bookId, title: p.title, author: p.author, addedAt: Date.now() };
  await d.transaction('rw', [d.books, d.chapters, d.paras, d.progress], async () => {
    await d.books.put(book);
    await d.chapters.bulkPut(p.chapters.map((c) => ({ ...c, bookId })));
    await d.paras.bulkPut(p.paras.map((x) => ({ ...x, bookId })));
    if (!(await d.progress.get(bookId))) {
      await d.progress.put({ bookId, paraId: p.paras[0]!.id, updatedAt: Date.now() });
    }
  });
}

/** 让这本书变成"当前书"（进度位置不动，只刷新时间）。 */
export async function touchProgress(d: ReaderDB, bookId: string): Promise<void> {
  const p = await d.progress.get(bookId);
  if (p) await d.progress.put({ ...p, updatedAt: Date.now() });
  else {
    const first = await d.paras.where('[bookId+chapter+idx]').between([bookId, 1, 0], [bookId, 1, Infinity]).first();
    if (first) await d.progress.put({ bookId, paraId: first.id, updatedAt: Date.now() });
  }
}

/** 当前书 = 最近读过（进度更新时间最新）的那本；都没读过就取最后导入的。没有书返回 null。 */
export async function currentBookId(d: ReaderDB): Promise<string | null> {
  const progress = await d.progress.toArray();
  const books = new Set((await d.books.toCollection().primaryKeys()) as string[]);
  const live = progress.filter((p) => books.has(p.bookId)).sort((a, b) => b.updatedAt - a.updatedAt);
  if (live[0]) return live[0].bookId;
  const last = await d.books.orderBy('addedAt').last();
  return last?.id ?? null;
}
