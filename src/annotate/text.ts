/**
 * 文本小工具：锚定用的规范化（带回原文的位置映射）、英文词计数、英文词切分。
 *
 * 规范化规则（PLAN 2.4(c)）：弯引号 → 直引号，各种空白连成一个空格，大小写不敏感。
 * 另外顺手：软连字符（U+00AD）丢掉。破折号、省略号原样保留（模型抄的时候一般不改它们）。
 */

const SINGLE_QUOTES = /['‘’‚‛′`´]/u;
const DOUBLE_QUOTES = /["“”„‟″]/u;
const SPACE = /\s/u;

export interface Normalized {
  /** 规范化后的文本 */
  norm: string;
  /** norm 第 i 个 UTF-16 单元来自原文的 [starts[i], ends[i]) */
  starts: number[];
  ends: number[];
}

/** 规范化并记下每个字符在原文里的位置，用来把匹配结果映射回原文偏移。 */
export function normalizeWithMap(s: string): Normalized {
  let norm = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  let lastWasSpace = false;
  while (i < s.length) {
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const len = ch.length;
    let out: string;
    if (ch === '­') {
      out = '';
    } else if (SPACE.test(ch)) {
      out = lastWasSpace ? '' : ' ';
    } else if (SINGLE_QUOTES.test(ch)) {
      out = "'";
    } else if (DOUBLE_QUOTES.test(ch)) {
      out = '"';
    } else {
      out = ch.toLowerCase();
    }
    if (out) {
      lastWasSpace = out === ' ';
      for (let k = 0; k < out.length; k++) {
        norm += out[k];
        starts.push(i);
        ends.push(i + len);
      }
    }
    i += len;
  }
  return { norm, starts, ends };
}

/** 只要规范化后的字符串（给 quote 用，不需要映射）。首尾空格去掉。 */
export function normalize(s: string): string {
  return normalizeWithMap(s).norm.trim();
}

const WORDISH = /[\p{L}\p{N}]/u;
export function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORDISH.test(ch);
}

/**
 * 英文词数（quote 上限 5 词用）。按空白和破折号切开，只算含字母或数字的片段。
 * "once more than strictly necessary" = 5；"well—you see" = 3；"Mrs. Darling's" = 2。
 */
export function englishWordCount(s: string): number {
  return s.split(/[\s—–]+/u).filter((w) => WORDISH.test(w)).length;
}

/** 文本里的拉丁字母词（含 don't / Darling's 这种撇号连写），带位置。中文不算词。 */
export interface Token {
  w: string;
  start: number;
  end: number;
}
const LATIN_WORD = /[A-Za-z0-9À-ɏ]+(?:['’][A-Za-z0-9À-ɏ]+)*/g;
export function latinTokens(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(LATIN_WORD)) {
    out.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 普通的词数统计（chunker 用，按空白切）。 */
export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/u).length : 0;
}
