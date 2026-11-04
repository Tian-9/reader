/**
 * 锚定解析器（PLAN 2.4(c)）：模型给"段落 + 短引文 quote + 第几次出现 occ"，这里算出原文里的字符偏移 [start, end)。
 *
 * 1. 段落和 quote 都规范化（弯直引号、空白、大小写），在规范化文本里找。
 * 2. 只认词边界上的匹配（"art" 不会匹配进 "start"）。
 * 3. 找到第 occ 次出现；occ 超出实际次数时退回第一次出现（算成功，计 occFallback）。
 * 4. 原样找不到时，去掉 quote 首尾的标点再试一次（模型常把逗号、引号带进来）。
 * 5. 还找不到、或 quote 超过 5 个词 → 失败，由调用方丢弃并计数。
 */
import { englishWordCount, isWordChar, normalize, normalizeWithMap } from './text';

export const MAX_QUOTE_WORDS = 5;

export type AnchorResult =
  | { ok: true; start: number; end: number; occFallback: boolean }
  | { ok: false; reason: 'too-long' | 'not-found' | 'empty' };

function findAll(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return out;
    const before = hay[i - 1];
    const after = hay[i + needle.length];
    const okStart = !isWordChar(needle[0]) || !isWordChar(before);
    const okEnd = !isWordChar(needle[needle.length - 1]) || !isWordChar(after);
    if (okStart && okEnd) out.push(i);
    from = i + 1;
  }
}

/** 去掉首尾非字母数字（标点、引号、空格）。 */
function trimPunct(q: string): string {
  return q.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

export function resolveAnchor(text: string, quote: string, occ: number): AnchorResult {
  if (!quote.trim()) return { ok: false, reason: 'empty' };
  if (englishWordCount(quote) > MAX_QUOTE_WORDS) return { ok: false, reason: 'too-long' };
  const { norm, starts, ends } = normalizeWithMap(text);
  const want = Math.max(1, Math.floor(occ || 1));
  for (const cand of [normalize(quote), normalize(trimPunct(quote))]) {
    if (!cand) continue;
    const hits = findAll(norm, cand);
    if (!hits.length) continue;
    const fallback = hits.length < want;
    const at = fallback ? hits[0]! : hits[want - 1]!;
    return { ok: true, start: starts[at]!, end: ends[at + cand.length - 1]!, occFallback: fallback };
  }
  return { ok: false, reason: 'not-found' };
}
