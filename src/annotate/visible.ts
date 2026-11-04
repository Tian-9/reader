/**
 * 显示过滤（PLAN 2.4(d)）：只显示等级高于阈值、且 lemma 不在"认识"集合里的生词。纯客户端，不调 API。
 *
 * 阈值 = 设置里的水平自评（B1 → 显示 B2 及以上）。请求时的"标注下限"是往下一档（A2），所以模型给的范围略宽，
 * 以后调阈值不用重标。
 * - fun 条目总是显示
 * - 已"我会"的：不显示
 * - 两道硬闸（不信模型给的 level，2026-11-04 首用反馈：country、Potter 被划了虚线）：
 *     常用词闸：lemma 在常用词表（NGSL）里按水平切的那一档 → 不显示（A1 前 500、A2 前 1000、B1 前 2000、B2 及以上整张表 2809 个 + 星期月份数字）
 *     专有名词闸：quote 首字母大写、不在句首、invented=false → 不显示（人名地名）
 *   她自己点过"加入生词本"（learning）的词不受这两道闸限制。
 * - 在词库里标过"不认识/在学"的：不管等级都显示
 * - 作者自造词（invented）：没标"我会"就显示
 */
import type { Annotation, HiddenReason, ReaderLevel } from '../types';
import { NGSL, NGSL_FORMS, NGSL_SUPPLEMENT } from './common-words';
import { LEVEL_INDEX, normLemma } from './words';

// ───────────────────────── 常用词闸 ─────────────────────────

/** 各水平"肯定认识"的 NGSL 前 N 个（按频率排名）。B2 及以上用整张表。 */
export const COMMON_TIER: Record<ReaderLevel, number> = {
  A1: 500,
  A2: 1000,
  B1: 2000,
  B2: Infinity,
  C1: Infinity,
  C2: Infinity,
};

let ranks: Map<string, number> | null = null;
function rankMap(): Map<string, number> {
  if (ranks) return ranks;
  const m = new Map<string, number>();
  NGSL.split(' ').forEach((w, i) => m.set(w, i + 1));
  // 补充表（星期、月份、数字）：任何水平都算常用
  for (const w of NGSL_SUPPLEMENT.split(' ')) if (!m.has(w)) m.set(w, 0);
  // 不规则词形（children、went、colour…）：排名跟它的 lemma
  for (const pair of NGSL_FORMS.split(' ')) {
    const [form, lemma] = pair.split(':');
    const r = lemma ? m.get(lemma) : undefined;
    if (form && r !== undefined && !m.has(form)) m.set(form, r);
  }
  ranks = m;
  return m;
}

/** 英式拼写特例（NGSL 是美式拼写）。规则能推的（-our/-ise/-tre/-ence/-ll-）不用列。 */
const UK_US: Record<string, string> = {
  grey: 'gray',
  mum: 'mom',
  programme: 'program',
  cheque: 'check',
  tyre: 'tire',
  plough: 'plow',
  practise: 'practice',
  storey: 'story',
  pyjamas: 'pajamas',
  towards: 'toward',
  whilst: 'while',
  amongst: 'among',
  aeroplane: 'airplane',
  maths: 'math',
};

/** 查表用的候选形：原形、英式→美式、去掉常见词尾（模型偶尔给的不是原形）。 */
export function lookupForms(lemma: string): string[] {
  const base = normLemma(lemma).replace(/^to /, '');
  if (!base || /[^a-z'-]/.test(base)) return []; // 短语（带空格）、带数字符号的不查
  const out = new Set<string>([base]);
  const uk = (w: string) => {
    const r = new Set<string>();
    if (UK_US[w]) r.add(UK_US[w]);
    if (w.includes('our')) r.add(w.replace(/our/g, 'or')); // colour, neighbour, favourite, honourable
    if (/is(e|ed|es|ing|ation|ations)$/.test(w)) r.add(w.replace(/is(e|ed|es|ing|ation|ations)$/, 'iz$1')); // realise, organisation
    if (/ys(e|ed|es|ing)$/.test(w)) r.add(w.replace(/ys(e|ed|es|ing)$/, 'yz$1')); // analyse
    if (/tre(s?)$/.test(w)) r.add(w.replace(/tre(s?)$/, 'ter$1')); // centre, theatre
    if (/ence$/.test(w)) r.add(w.replace(/ence$/, 'ense')); // defence, licence
    if (/ogue$/.test(w)) r.add(w.replace(/ogue$/, 'og')); // catalogue
    if (/([aeiou])ll(ed|ing|er|ers)$/.test(w)) r.add(w.replace(/([aeiou])ll(ed|ing|er|ers)$/, '$1l$2')); // travelled
    return r;
  };
  const stems = (w: string) => {
    const r = new Set<string>();
    const add = (s: string) => s.length >= 2 && r.add(s);
    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/es$/.test(w)) add(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
    if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ed$/.test(w)) {
      add(w.slice(0, -2));
      add(w.slice(0, -1));
      if (/([^aeiou])\1ed$/.test(w)) add(w.slice(0, -3)); // stopped
    }
    if (/ing$/.test(w)) {
      add(w.slice(0, -3));
      add(w.slice(0, -3) + 'e');
      if (/([^aeiou])\1ing$/.test(w)) add(w.slice(0, -4)); // running
    }
    if (/ily$/.test(w)) add(w.slice(0, -3) + 'y'); // happily
    if (/ly$/.test(w)) add(w.slice(0, -2)); // quickly, carefully
    return r;
  };
  for (const f of uk(base)) out.add(f);
  for (const f of [...out]) for (const s of stems(f)) out.add(s);
  for (const f of [...out]) for (const s of uk(f)) out.add(s);
  return [...out];
}

/** 常用词表里的排名（1 起；补充表的星期月份数字是 0）；不在表里返回 null。 */
export function commonRank(lemma: string): number | null {
  const m = rankMap();
  let best: number | null = null;
  for (const f of lookupForms(lemma)) {
    const r = m.get(f);
    if (r !== undefined && (best === null || r < best)) best = r;
  }
  return best;
}

/** 这个 lemma 对这个水平的读者来说是不是"肯定认识"的常用词。 */
export function isCommonWord(lemma: string, level: ReaderLevel): boolean {
  const r = commonRank(lemma);
  return r !== null && r <= COMMON_TIER[level];
}

// ───────────────────────── 专有名词闸 ─────────────────────────

const OPENERS = new Set(['“', '"', '‘', "'", '(', '[', '«']);
const CLOSERS = new Set(['”', '"', '’', "'", ')', ']', '»']);
/** 句号后面跟大写词、但不是句子结束的称谓缩写（Mr. Dursley） */
const ABBREV = /(?:^|[^\p{L}])(mr|mrs|ms|dr|st|prof|mt|jr|sr|capt|col|gen|lt|sgt|rev|hon|messrs)$/iu;

/** text[start] 是不是一句话（或一段引语）的开头。 */
export function isSentenceStart(text: string, start: number): boolean {
  let i = start;
  // 紧挨着的开引号/括号：引语开头的大写词当句首（“To Harry … 的 To）
  if (i > 0 && OPENERS.has(text[i - 1]!)) return true;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  if (i === 0) return true;
  // 先跳过闭引号/括号：lived!” Harry
  let j = i;
  while (j > 0 && CLOSERS.has(text[j - 1]!)) j--;
  const c = text[j - 1];
  if (c === undefined) return true;
  if (c === ':' || c === '…' || c === '!' || c === '?') return true;
  if (c === '.') return !ABBREV.test(text.slice(Math.max(0, j - 12), j - 1));
  // 前面是空格后紧跟开引号的情况（, “Potter）已在上面处理；其余都算句中
  return false;
}

/**
 * quote 像不像人名/地名：首字母大写、不在句首。
 * - 单独的 "I"（I daresay）不算
 * - 多词 quote 里有小写开头的词（Brussels sprout）是普通名词短语，不算
 */
export function looksProperNoun(text: string, start: number, quote: string): boolean {
  const q = quote.trim();
  if (!/^\p{Lu}/u.test(q)) return false;
  const words = q.split(/\s+/);
  if (/^I(['’](m|d|ll|ve))?$/.test(words[0]!)) return false;
  if (words.some((w) => /^\p{Ll}/u.test(w))) return false;
  return !isSentenceStart(text, start);
}

// ───────────────────────── 合起来 ─────────────────────────

type GateFields = Pick<Annotation, 'kind' | 'lemma' | 'quote' | 'start' | 'invented'> & Partial<Pick<Annotation, 'hiddenReason'>>;

/**
 * 两道硬闸：为什么这条 vocab 不该显示（不看模型给的 level）。
 * paraText 拿不到时（老数据），专有名词闸退回用入库时记下的 hiddenReason。常用词闸总是按当前水平现算。
 */
export function hiddenReason(a: GateFields, level: ReaderLevel, paraText?: string): HiddenReason | null {
  if (a.kind !== 'vocab') return null;
  if (isCommonWord(a.lemma || a.quote, level)) return 'common';
  // 划线的只是一个常用词、lemma 却写成短语（quote "country"、lemma "all over the country"）：按划线的那个词算
  const q = a.quote.trim();
  if (q && !/\s/.test(q) && isCommonWord(q.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''), level)) return 'common';
  if (!a.invented) {
    if (paraText !== undefined ? looksProperNoun(paraText, a.start, a.quote) : a.hiddenReason === 'proper') return 'proper';
  }
  return null;
}

export interface VisibleOpts {
  /** 段落原文（专有名词闸判断句首用）；不给就用入库时记的 hiddenReason */
  paraText?: (paraId: string) => string | undefined;
  /** 她自己点过"加入生词本"的 lemma：不受两道闸限制 */
  learning?: Set<string>;
}

export function isVisible(
  a: Pick<Annotation, 'kind' | 'lemma' | 'level' | 'invented'> & Partial<Pick<Annotation, 'quote' | 'start' | 'paraId' | 'hiddenReason'>>,
  threshold: ReaderLevel,
  known: Set<string>,
  marked: Set<string>,
  opts: VisibleOpts = {},
): boolean {
  if (a.kind === 'fun') return true;
  const lemma = normLemma(a.lemma);
  if (known.has(lemma)) return false;
  if (!opts.learning?.has(lemma)) {
    const text = a.paraId !== undefined ? opts.paraText?.(a.paraId) : undefined;
    const gate = hiddenReason({ ...a, quote: a.quote ?? a.lemma, start: a.start ?? 0 }, threshold, text);
    if (gate) return false;
  }
  if (marked.has(lemma) || a.invented || a.level === '-') return true;
  return (LEVEL_INDEX[a.level] ?? 99) > LEVEL_INDEX[threshold]!;
}

/** 标注下限 = 水平往下一档（A1 不再往下）。 */
export function levelFloor(level: ReaderLevel): ReaderLevel {
  const order: ReaderLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  return order[Math.max(0, order.indexOf(level) - 1)]!;
}

/** 本章生词表（目录面板"本章生词"）：可见的 vocab 按出现顺序（段落序号 → 段内位置），同 lemma 只留第一处。 */
export function chapterVocabList<T extends Pick<Annotation, 'kind' | 'paraId' | 'start' | 'lemma'>>(visible: T[]): T[] {
  const idx = (pid: string) => Number(/p(\d+)$/.exec(pid)?.[1] ?? 0);
  const seen = new Set<string>();
  return visible
    .filter((a) => a.kind === 'vocab')
    .sort((a, b) => idx(a.paraId) - idx(b.paraId) || a.paraId.localeCompare(b.paraId) || a.start - b.start)
    .filter((a) => {
      const l = normLemma(a.lemma);
      if (!l || seen.has(l)) return false;
      seen.add(l);
      return true;
    });
}
