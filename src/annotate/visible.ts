/**
 * 显示过滤（PLAN 2.4(d)）：只显示等级高于阈值、且 lemma 不在"认识"集合里的生词。纯客户端，不调 API。
 *
 * 阈值 = 设置里的水平自评（B1 → 显示 B2 及以上）。请求时的"标注下限"是往下一档（A2），所以模型给的范围略宽，
 * 以后调阈值不用重标。
 * - fun 条目总是显示
 * - 在词库里标过"不认识/在学"的：不管等级都显示
 * - 作者自造词（invented）：没标"我会"就显示
 */
import type { Annotation, ReaderLevel } from '../types';
import { LEVEL_INDEX, normLemma } from './words';

export function isVisible(
  a: Pick<Annotation, 'kind' | 'lemma' | 'level' | 'invented'>,
  threshold: ReaderLevel,
  known: Set<string>,
  marked: Set<string>,
): boolean {
  if (a.kind === 'fun') return true;
  const lemma = normLemma(a.lemma);
  if (known.has(lemma)) return false;
  if (marked.has(lemma) || a.invented || a.level === '-') return true;
  return (LEVEL_INDEX[a.level] ?? 99) > LEVEL_INDEX[threshold]!;
}

/** 标注下限 = 水平往下一档（A1 不再往下）。 */
export function levelFloor(level: ReaderLevel): ReaderLevel {
  const order: ReaderLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  return order[Math.max(0, order.indexOf(level) - 1)]!;
}
