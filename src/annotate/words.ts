/**
 * 词库（PLAN 2.4(d) / 2.5）：words 表按 lemma 记三态 known / learning / unknown。
 *
 * - "这个我会" → known（source=dismissed），全书同 lemma 立刻不再显示（显示过滤在 visible.ts，不调 API）
 * - "加入生词本" → learning（source=self-rated）
 * - 点开一个生词 / 点词补注 → 没记过的记成 unknown（source=tapped），taps+1；已经 known/learning 的不改状态
 * - 连续 N 次在同一级别点"我会" → 提示要不要调阈值（只提示）
 */
import type { ReaderDB } from '../db/db';
import { READER_LEVELS, type Level, type ReaderLevel, type Word, type WordStatus } from '../types';

/** lemma 统一成小写、去首尾空白、弯撇号变直，作为词库主键。 */
export function normLemma(s: string): string {
  return s.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
}

export interface WordInput {
  lemma: string;
  level?: Level;
  glossZh?: string;
  bookId: string;
  paraId: string;
}

async function upsert(d: ReaderDB, w: WordInput, patch: (old: Word | undefined) => Partial<Word>): Promise<Word> {
  const lemma = normLemma(w.lemma);
  if (!lemma) throw new Error('空 lemma');
  return d.transaction('rw', d.words, async () => {
    const old = await d.words.get(lemma);
    const row: Word = {
      lemma,
      status: 'unknown',
      source: 'tapped',
      glossZh: w.glossZh ?? '',
      firstSeen: { bookId: w.bookId, paraId: w.paraId },
      taps: 0,
      ...(old ?? {}),
      ...(w.level && w.level !== '-' ? { level: w.level } : {}),
      ...(w.glossZh && !old?.glossZh ? { glossZh: w.glossZh } : {}),
      ...patch(old),
      updatedAt: Date.now(),
    };
    await d.words.put(row);
    return row;
  });
}

/** "这个我会" */
export function markKnown(d: ReaderDB, w: WordInput): Promise<Word> {
  return upsert(d, w, () => ({ status: 'known', source: 'dismissed' }));
}

/** "加入生词本" */
export function addToLearning(d: ReaderDB, w: WordInput): Promise<Word> {
  return upsert(d, w, () => ({ status: 'learning', source: 'self-rated' }));
}

/** "其实还不熟"：把 known 撤回成 unknown。 */
export function unmarkKnown(d: ReaderDB, w: WordInput): Promise<Word> {
  return upsert(d, w, () => ({ status: 'unknown', source: 'tapped' }));
}

/** 点开了一个生词（或点词补注）：没记过的记成 unknown，taps+1；known/learning 保持原状态。 */
export function noteTapped(d: ReaderDB, w: WordInput): Promise<Word> {
  return upsert(d, w, (old) => ({
    taps: (old?.taps ?? 0) + 1,
    ...(old ? {} : { status: 'unknown' as WordStatus, source: 'tapped' as const }),
  }));
}

export function lemmaSets(words: Word[]): { known: Set<string>; marked: Set<string> } {
  const known = new Set<string>();
  const marked = new Set<string>();
  for (const w of words) (w.status === 'known' ? known : marked).add(w.lemma);
  return { known, marked };
}

export const LEVEL_INDEX: Record<string, number> = Object.fromEntries(READER_LEVELS.map((l, i) => [l, i]));

/** 往上一档（C2 封顶）。 */
export function levelAbove(l: ReaderLevel): ReaderLevel {
  return READER_LEVELS[Math.min(READER_LEVELS.length - 1, LEVEL_INDEX[l]! + 1)]!;
}

export const STREAK_N = 15;

export interface ThresholdHint {
  /** 连着点"我会"的那一级 */
  level: ReaderLevel;
  count: number;
  /** 建议把水平自评调成这一级（以后只标它以上的） */
  suggest: ReaderLevel;
}

/**
 * 最近一串"我会"是不是都在同一级、且够 N 次（每满 N 次提示一回，不反复唠叨）。
 * 只看 source=dismissed 的词，按时间倒序；遇到不同级别就断。只在那一级高于当前阈值时提示。
 */
export function thresholdHint(words: Word[], current: ReaderLevel, n = STREAK_N): ThresholdHint | null {
  const dismissed = words
    .filter((w) => w.status === 'known' && w.source === 'dismissed' && w.level && w.level !== '-')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const first = dismissed[0];
  if (!first) return null;
  const lvl = first.level as ReaderLevel;
  let count = 0;
  for (const w of dismissed) {
    if (w.level !== lvl) break;
    count++;
  }
  if (count < n || count % n !== 0) return null;
  if (LEVEL_INDEX[lvl]! <= LEVEL_INDEX[current]!) return null;
  return { level: lvl, count, suggest: lvl };
}
