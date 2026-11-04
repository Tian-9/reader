/**
 * 拼标注请求的 user 消息（PLAN 3.1 / ANNOTATE_USER_TEMPLATE）。顺序：变化越少越往前。
 *   <reader_profile>（水平、标注下限、known 60 / unknown 40 样本）
 *   <story_so_far>（summaries 表里前几章的中文摘要，≤600 字，没有就空）
 *   <already_noted>（本章前面几组已经标过的 lemma）
 *   <passage>（本组段落，每段前面带 [段落编号]）
 */
import type { ReaderDB } from '../db/db';
import { parseParaId, type ParaRow, type ReaderLevel, type Word } from '../types';
import { isCommonWord } from './visible';
import { LEVEL_INDEX, normLemma } from './words';

export const KNOWN_SAMPLE = 60;
export const UNKNOWN_SAMPLE = 40;
/** <known> 里无条件保留最近这么多个（保证刚点的"我会"一定在下一次请求里） */
const KNOWN_RECENT_KEEP = 10;
const STORY_MAX_CHARS = 600;

/**
 * <known> 样本：最近 60 个标为认识的词，优先选接近阈值的。
 * 先保最近 10 个，其余从最近 200 个里按"离阈值的级距"排（同距按新旧）。常用词表里的词不进样本。
 */
export function knownSample(words: Word[], threshold: ReaderLevel, n = KNOWN_SAMPLE): string[] {
  // 常用词表里的词显示层反正会藏，不用占 <known> 的名额（省 token）
  const known = words
    .filter((w) => w.status === 'known' && !isCommonWord(w.lemma, threshold))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const keep = known.slice(0, Math.min(KNOWN_RECENT_KEEP, n));
  const t = LEVEL_INDEX[threshold]!;
  const dist = (w: Word) => (w.level && w.level !== '-' ? Math.abs(LEVEL_INDEX[w.level]! - t) : 2.5);
  const rest = known
    .slice(keep.length, 200)
    .map((w, i) => ({ w, i }))
    .sort((a, b) => dist(a.w) - dist(b.w) || a.i - b.i)
    .map((x) => x.w)
    .slice(0, n - keep.length);
  return [...keep, ...rest].map((w) => w.lemma);
}

/**
 * <unknown> 样本：最近 40 个点过或标为不认识/在学的词。
 * 常用词表里的词（多半是误点出来的 unknown）不进样本，除非她自己加进了生词本（learning）。
 */
export function unknownSample(words: Word[], threshold?: ReaderLevel, n = UNKNOWN_SAMPLE): string[] {
  return words
    .filter((w) => w.status !== 'known' && (w.status === 'learning' || !threshold || !isCommonWord(w.lemma, threshold)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, n)
    .map((w) => w.lemma);
}

/** 前情摘要：本章之前各章的摘要，从最近的往前取，总长 ≤600 字（T4 的聊天传更大的 maxChars）。 */
export async function storySoFar(d: ReaderDB, bookId: string, chapter: number, maxChars = STORY_MAX_CHARS): Promise<string> {
  const rows = (await d.summaries.where('bookId').equals(bookId).toArray())
    .filter((s) => s.chapter < chapter)
    .sort((a, b) => b.chapter - a.chapter);
  const picked: string[] = [];
  let len = 0;
  for (const s of rows) {
    const t = `第${s.chapter}章：${s.textZh.trim()}`;
    if (len + t.length > maxChars) {
      if (!picked.length) picked.push(t.slice(0, maxChars));
      break;
    }
    picked.push(t);
    len += t.length;
  }
  return picked.reverse().join('\n');
}

/** 本章其他组已经标过的 vocab lemma（去重、保持出现顺序）。 */
export async function alreadyNoted(d: ReaderDB, bookId: string, chapter: number, excludeChunkId: string): Promise<string[]> {
  const rows = await d.annotations.where('bookId').equals(bookId).toArray();
  const seen = new Set<string>();
  for (const a of rows.sort((x, y) => x.paraId.localeCompare(y.paraId) || x.start - y.start)) {
    if (a.kind !== 'vocab' || a.chunkId === excludeChunkId) continue;
    if (parseParaId(a.paraId)?.chapter !== chapter) continue;
    const l = normLemma(a.lemma);
    if (l) seen.add(l);
  }
  return [...seen];
}

export interface AnnotateUserParts {
  level: ReaderLevel;
  floor: ReaderLevel;
  known: string[];
  unknown: string[];
  story: string;
  noted: string[];
  paras: Pick<ParaRow, 'id' | 'text'>[];
}

export function buildAnnotateUser(x: AnnotateUserParts): string {
  const passage = x.paras.map((p) => `[${p.id}] ${p.text.replace(/\s*\n\s*/g, ' ')}`).join('\n');
  return [
    '<reader_profile>',
    `水平自评：${x.level}；标注下限：${x.floor}`,
    `<known>${x.known.join(', ')}</known>`,
    `<unknown>${x.unknown.join(', ')}</unknown>`,
    '</reader_profile>',
    `<story_so_far>${x.story}</story_so_far>`,
    `<already_noted>${x.noted.join(', ')}</already_noted>`,
    '<passage>',
    passage,
    '</passage>',
  ].join('\n');
}

/** 从拼好的 user 消息里取出 <known> 列表（日志 / 验收用）。 */
export function knownFromUser(user: string): string[] {
  const m = /<known>([\s\S]*?)<\/known>/.exec(user);
  return m && m[1] ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}
