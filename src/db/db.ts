/**
 * 本地数据库（IndexedDB，经 Dexie）。PLAN 2.4(b) 的表 + T1 补的 chapters / settings。
 * 书、标注、词库、聊天、账本全在手机本地，不同步、不上传。
 *
 * 坑（pocketverse 踩过）：
 * - Svelte 5 的 $state 对象是 Proxy，直接 put 进来会 DataCloneError。写库前一律 $state.snapshot(x)。
 * - liveQuery 里不能写库。
 * - 改表结构：加一个新的 this.version(n+1).stores({...})，别改旧版本号里的定义。
 */
import Dexie, { type EntityTable, type Table } from 'dexie';
import type {
  Annotation, Book, ChapterRow, ChatRecord, ChunkRow, LedgerEntry, ParaRow, Progress, Settings, Summary, Word,
} from '../types';

/** settings 表只有一行，主键固定为 'app'。 */
export interface SettingsRow extends Settings {
  key: 'app';
}

export class ReaderDB extends Dexie {
  books!: EntityTable<Book, 'id'>;
  /** 主键 [bookId+id]；按章顺序读用 [bookId+chapter+idx] */
  paras!: Table<ParaRow, [string, string]>;
  /** 主键 [bookId+n] */
  chapters!: Table<ChapterRow, [string, number]>;
  /** 主键 [bookId+chunkId] */
  chunks!: Table<ChunkRow, [string, string]>;
  annotations!: EntityTable<Annotation, 'id'>;
  words!: EntityTable<Word, 'lemma'>;
  progress!: EntityTable<Progress, 'bookId'>;
  /** 主键 [bookId+chapter] */
  summaries!: Table<Summary, [string, number]>;
  chats!: EntityTable<ChatRecord, 'id'>;
  ledger!: EntityTable<LedgerEntry, 'id'>;
  settings!: EntityTable<SettingsRow, 'key'>;

  constructor(name = 'reader') {
    super(name);
    this.version(1).stores({
      books: 'id, addedAt',
      paras: '[bookId+id], bookId, [bookId+chapter+idx]',
      chapters: '[bookId+n], bookId',
      chunks: '[bookId+chunkId], bookId, [bookId+status]',
      annotations: 'id, bookId, chunkId, [bookId+paraId], lemma',
      words: 'lemma, status, updatedAt',
      progress: 'bookId',
      summaries: '[bookId+chapter], bookId',
      chats: 'id, bookId, createdAt',
      ledger: '++id, ts, bookId, purpose',
      settings: 'key',
    });
  }
}

let instance: ReaderDB | null = null;

/** 全局唯一的库。测试里用 new ReaderDB('test-xxx') 自己开一个。 */
export function db(): ReaderDB {
  instance ??= new ReaderDB();
  return instance;
}

/** 某一章的段落，按段号排好。T2 阅读视图、T3 分组都用这个。 */
export function chapterParas(d: ReaderDB, bookId: string, chapter: number): Promise<ParaRow[]> {
  return d.paras
    .where('[bookId+chapter+idx]')
    .between([bookId, chapter, Dexie.minKey], [bookId, chapter, Dexie.maxKey])
    .toArray();
}
