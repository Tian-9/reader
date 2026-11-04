/**
 * 把一段正文拆成"词"和"词之间的东西"。start/end 是段内 UTF-16 偏移（JS 字符串下标），[start, end)，
 * 和 T3 的 Annotation.start/end 是同一套坐标。
 *
 * 词的定义：字母/数字连成一串，中间允许夹一个撇号（直的 ' 或弯的 ’）或连字符：
 *   can’t、o'clock、good-bye、14 都是一个词；“Oh 里的弯引号不算进词。
 */
export interface WordToken {
  start: number;
  end: number;
  surface: string;
}

const WORD_RE = /[\p{L}\p{N}\p{M}]+(?:['’\-‐][\p{L}\p{N}\p{M}]+)*/gu;

export function tokenize(text: string): WordToken[] {
  const out: WordToken[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const start = m.index;
    out.push({ start, end: start + m[0].length, surface: m[0] });
  }
  return out;
}

/** 词数（导入统计、乱码兜底用）。 */
export function countWords(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(WORD_RE)) n++;
  return n;
}

/** 段内第 offset 个字符落在哪个词上（落在空格/标点上返回 null）。点词的兜底路径用。 */
export function wordAt(text: string, offset: number): WordToken | null {
  for (const t of tokenize(text)) {
    if (offset < t.start) return null;
    if (offset < t.end) return t;
  }
  return null;
}

export type Segment = { word: true; start: number; end: number; text: string } | { word: false; text: string };

/** 渲染用：词和间隙交替排列，拼起来等于原文。 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const t of tokenize(text)) {
    if (t.start > pos) out.push({ word: false, text: text.slice(pos, t.start) });
    out.push({ word: true, start: t.start, end: t.end, text: t.surface });
    pos = t.end;
  }
  if (pos < text.length) out.push({ word: false, text: text.slice(pos) });
  return out;
}
