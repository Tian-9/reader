/**
 * 输出守卫（PLAN 第 4 节"AI 输出不含原文整句"）：
 * - 标注的 quote 超过 5 个词 → 丢弃（在 anchor.ts 里判，这里给个独立的判断函数）
 * - 任何文本字段和当前段落有 ≥8 个英文词连续重合 → 把重合的那段替换成"（原文略）"
 * 每次触发由调用方记一笔（guardEvents 表）。T4 的聊天回复也用 redactOverlap。
 */
import { MAX_QUOTE_WORDS } from './anchor';
import { englishWordCount, latinTokens } from './text';

export const OVERLAP_WORDS = 8;
export const REDACTED = '（原文略）';

export function quoteTooLong(quote: string): boolean {
  return englishWordCount(quote) > MAX_QUOTE_WORDS;
}

/** 把若干段原文做成"8 词连续片段"集合，一次建好可以给多个字段复用。 */
export function overlapIndex(sources: string[], n = OVERLAP_WORDS): Set<string> {
  const grams = new Set<string>();
  for (const s of sources) {
    const w = latinTokens(s).map((t) => t.w);
    for (let i = 0; i + n <= w.length; i++) grams.add(w.slice(i, i + n).join(' '));
  }
  return grams;
}

/**
 * 字段里和原文连续重合 ≥n 个词的部分替换成"（原文略）"。没有重合原样返回、hit=false。
 * 重合段从第一个重合词的开头替换到最后一个重合词的结尾（中间的标点一起吞掉）。
 */
export function redactOverlap(field: string, index: Set<string>, n = OVERLAP_WORDS): { text: string; hit: boolean } {
  if (!index.size || !field) return { text: field, hit: false };
  const toks = latinTokens(field);
  if (toks.length < n) return { text: field, hit: false };
  const marked = new Array<boolean>(toks.length).fill(false);
  for (let i = 0; i + n <= toks.length; i++) {
    const g = toks.slice(i, i + n).map((t) => t.w).join(' ');
    if (index.has(g)) for (let k = i; k < i + n; k++) marked[k] = true;
  }
  if (!marked.includes(true)) return { text: field, hit: false };
  let out = '';
  let pos = 0;
  for (let i = 0; i < toks.length; i++) {
    if (!marked[i]) continue;
    let j = i;
    while (j + 1 < toks.length && marked[j + 1]) j++;
    out += field.slice(pos, toks[i]!.start) + REDACTED;
    pos = toks[j]!.end;
    i = j;
  }
  out += field.slice(pos);
  return { text: out, hit: true };
}
