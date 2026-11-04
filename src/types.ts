/**
 * 共享接口（PLAN 2.3 / 2.4）。T2（EPUB 导入 + 阅读器）和 T3（标注管线 + 词库）都只认这里的形状。
 * 改字段 = 改合同：先改这里，再让两边对齐，Dexie 表结构在 src/db/db.ts。
 */
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

// ───────────────────────── 书与段落（T2 产出，T3 消费） ─────────────────────────

/** 一段正文。id 形如 "c03p0012"（第 3 章第 12 段），见 paraId()。text 已做 NFC 规范化，保留弯引号。 */
export interface Para {
  id: string;
  /** 章号，从 1 开始（Gutenberg 的封面壳、license 不算章） */
  chapter: number;
  /** 本章内段号，从 1 开始 */
  idx: number;
  text: string;
}

/** 一章。paraIds 按阅读顺序。标题来自 NAV/NCX 目录。 */
export interface Chapter {
  n: number;
  title: string;
  paraIds: string[];
}

/** 段落编号："c" + 章号（至少 2 位）+ "p" + 段号（至少 4 位）。超过 99 章时章号自然变 3 位，排序请用 [chapter, idx]，别按字符串排。 */
export function paraId(chapter: number, idx: number): string {
  return `c${String(chapter).padStart(2, '0')}p${String(idx).padStart(4, '0')}`;
}

/** paraId 反解；格式不对返回 null。 */
export function parseParaId(id: string): { chapter: number; idx: number } | null {
  const m = /^c(\d{2,})p(\d{4,})$/.exec(id);
  return m ? { chapter: Number(m[1]), idx: Number(m[2]) } : null;
}

/** books 表。id = 原始 EPUB 文件的 sha256（hex），同一本书重复导入不会多一份。 */
export interface Book {
  id: string;
  title: string;
  author: string;
  addedAt: number;
}

/** paras 表的一行 = Para + 所属书。主键 [bookId+id]。 */
export interface ParaRow extends Para {
  bookId: string;
}

/** chapters 表的一行 = Chapter + 所属书。主键 [bookId+n]。（PLAN 2.4(b) 没列这张表，T1 补上，用来存目录标题。） */
export interface ChapterRow extends Chapter {
  bookId: string;
}

// ───────────────────────── 标注（T3） ─────────────────────────

/** CEFR 分级。"-" 用于 fun 条目。 */
export type Level = 'A2' | 'B1' | 'B2' | 'C1' | 'C2' | '-';
/** 读者水平自评只用真实等级。A1 也放进来，方便算"往下一档"。 */
export type ReaderLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export const READER_LEVELS: ReaderLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export type AnnotationKind = 'vocab' | 'fun';
export type FunType = '-' | '双关' | '英式表达' | '爱尔兰/方言' | '反讽' | '文化梗' | '作者幽默';

/** 模型按 schema 返回的一条（字段名和 JSON 一致，snake_case）。schema 本体在 src/llm/prompts/annotate.ts。 */
export interface AnnotationItem {
  kind: AnnotationKind;
  /** 段落编号 */
  p: string;
  /** 从该段逐字照抄的 1-5 个英文词 */
  quote: string;
  /** quote 在该段第几次出现，从 1 开始 */
  occ: number;
  lemma: string;
  level: Level;
  invented: boolean;
  fun_type: FunType;
  gloss_zh: string;
  note_zh: string;
}

export interface AnnotationResponse {
  items: AnnotationItem[];
}

/** 一组待标注的段落（chunk）。chunkId = 第一段的 paraId。主键 [bookId+chunkId]。 */
export interface ChunkRow {
  bookId: string;
  chunkId: string;
  paraIds: string[];
  status: 'todo' | 'done' | 'error';
  model: string;
  promptVersion: number;
  /** 请求时的标注下限（读者水平往下一档） */
  levelFloor: ReaderLevel;
}

/** annotations 表：锚定成功、过了输出守卫后入库的标注。start/end 是客户端算出来的段内字符偏移（[start, end)）。 */
export interface Annotation {
  id: string;
  bookId: string;
  chunkId: string;
  paraId: string;
  kind: AnnotationKind;
  quote: string;
  start: number;
  end: number;
  lemma: string;
  level: Level;
  invented: boolean;
  funType: FunType;
  glossZh: string;
  noteZh: string;
  model: string;
  createdAt: number;
}

// ───────────────────────── 词库（T3） ─────────────────────────

export type WordStatus = 'known' | 'learning' | 'unknown';
export type WordSource = 'dismissed' | 'tapped' | 'self-rated';

/** words 表，按 lemma 记（认识 go 就等于认识 went）。 */
export interface Word {
  lemma: string;
  status: WordStatus;
  source: WordSource;
  glossZh: string;
  firstSeen: { bookId: string; paraId: string };
  taps: number;
  updatedAt: number;
}

// ───────────────────────── 进度、摘要、聊天、账本（T2 / T4 / T5） ─────────────────────────

export interface Progress {
  bookId: string;
  paraId: string;
  updatedAt: number;
}

/** 章节前情摘要，主键 [bookId+chapter]。 */
export interface Summary {
  bookId: string;
  chapter: number;
  textZh: string;
  model: string;
}

export interface ChatRecord {
  id: string;
  bookId: string;
  lang: 'zh' | 'en';
  /** 原样存 SDK 的消息结构，回放时直接塞回 messages。存库前记得 $state.snapshot。 */
  messages: MessageParam[];
  createdAt: number;
}

export type Purpose = 'annotate' | 'tap' | 'summary' | 'chat';

/** 花费账本，一次 API 调用一行。bookId 是 T1 补的（PLAN 只写了"这本书花了多少"，没写怎么按书分）。 */
export interface LedgerEntry {
  id?: number;
  ts: number;
  bookId?: string;
  purpose: Purpose;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

// ───────────────────────── 设置 ─────────────────────────

export interface Settings {
  /** 应用口令。不是 API key，只是代理认人用的。 */
  appToken: string;
  level: ReaderLevel;
  /** 防剧透，默认关（她熟 HP 中文版，PLAN 第 7 节） */
  noSpoilers: boolean;
  /** 各用途的模型覆盖；没写的走 llm/roles.ts 的默认表 */
  models: Partial<Record<Purpose, string>>;
  /** T2 补：阅读字号（px）。没设走 app.css 的 --read-size（19px） */
  readSize?: number;
  /** T2 补：阅读行距（倍数）。没设走 app.css 的 --read-leading（1.7） */
  readLeading?: number;
}
