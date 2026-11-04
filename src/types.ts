/**
 * 共享接口（PLAN 2.3 / 2.4）。T2（EPUB 导入 + 阅读器）和 T3（标注管线 + 词库）都只认这里的形状。
 * 改字段 = 改合同：先改这里，再让两边对齐，Dexie 表结构在 src/db/db.ts。
 */
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
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
export type FunType = '-' | '双关' | '英式表达' | '方言/口音' | '反讽' | '文化梗' | '作者幽默';

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
  /** T3 补：这一组的锚定/守卫统计（status=done 时有）。用来算"锚定失败率"、观察 prompt 好不好使。 */
  stats?: ChunkStats;
}

/** T3 补：一次标注调用的结果统计。 */
export interface ChunkStats {
  /** 模型返回的条目数 */
  items: number;
  /** 锚定成功并入库的条数 */
  stored: number;
  /** 找不到 quote（或段落编号不在本组）而丢弃 */
  anchorFail: number;
  /** quote 超过 5 词而丢弃 */
  quoteTooLong: number;
  /** occ 对不上、退回第一次出现的条数（算锚定成功） */
  occFallback: number;
  /** 文本字段被"（原文略）"替换的次数 */
  overlapHits: number;
  /** 因为 Haiku 拒绝而用重试模型跑的 */
  refusalRetried: boolean;
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
  /** T3 补：这个词的 CEFR 等级（来自标注或点词补注）。用来挑 <known> 样本、判断"连续同级点我会"。 */
  level?: Level;
}

// ───────────────────────── T3 补：守卫记账、界面事件 ─────────────────────────

/**
 * 输出守卫/锚定的一笔触发记录（guardEvents 表）。只记"发生了什么"，不存模型输出原文。
 * T4 的聊天守卫也往这里记（purpose = 'chat'）。
 */
export interface GuardEvent {
  id?: number;
  ts: number;
  bookId: string;
  purpose: Purpose;
  kind: 'anchor-fail' | 'quote-too-long' | 'overlap' | 'refusal';
  paraId?: string;
  /** 哪个字段触发的（overlap 时是 gloss_zh / note_zh 等） */
  field?: string;
}

/** T2 阅读视图派发的点词事件（CustomEvent 'word-tap' 的 detail）。start/end 是段内字符偏移 [start, end)。 */
export interface WordTapDetail {
  paraId: string;
  start: number;
  end: number;
  surface: string;
}

/** 卡片上"问小克"派发的事件（CustomEvent 'ask-xiaoke' 的 detail，冒泡到 window）。T4 监听它打开抽屉。 */
export interface AskXiaokeDetail {
  bookId: string;
  paraId: string;
  /** 被问的那几个字（≤5 词） */
  quote: string;
  kind: AnnotationKind;
  lemma: string;
  glossZh: string;
  noteZh: string;
  annotationId?: string;
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
  /**
   * 原样存 SDK 的消息结构，回放时直接塞回 messages。存库前记得 $state.snapshot。
   * T4 补：放宽成也收 beta 消息（中英切换用的中途 role:"system" 消息只在 beta 类型里）。
   * 只追加不改写：助手回复连 thinking 块原样存（改历史会让后面的 thinking 签名失效、缓存全废）。
   */
  messages: (MessageParam | BetaMessageParam)[];
  createdAt: number;
  /** T4 补：最后一次说话的时间 */
  updatedAt?: number;
  /** T4 补：这个会话开始时读到第几章（换章后开新会话，前情摘要跟着换） */
  chapter?: number;
  /** T4 补：这个会话用的聊天模型（换模型缓存不通用） */
  model?: string;
  /** T4 补：抽屉里显示的内容（她的原话 + 过了守卫的回复）。和 messages 分开存：守卫只改显示，不改发回去的历史。 */
  display?: ChatLine[];
}

/** T4 补：抽屉里的一行。note 是界面提示（切英文、被拒、出错），不发给模型。 */
export interface ChatLine {
  role: 'user' | 'assistant' | 'note';
  text: string;
  /** 回复被输出守卫改过（有"（原文略）"） */
  guarded?: boolean;
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
  /**
   * Anthropic API key（直连模式，PLAN 2.6）。只存在这台设备的 IndexedDB，不进备份、不上传任何服务器（除了 api.anthropic.com 本身）。
   */
  apiKey: string;
  /** @deprecated 代理模式的应用口令，直连后不用了。老库里可能还有，loadSettings 时丢掉。 */
  appToken?: string;
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
