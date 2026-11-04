/**
 * 分组（chunker，PLAN 3.1）：一章内按段落攒成 600–900 词一组，不在段落中间切，不跨章。
 * 组号 chunkId = 该组第一段的 paraId。
 *
 * 规则：
 * - 顺序往里放段落；放下一段会超过 900 词时：已经 ≥600 就收组；不到 600 就看"放进去超出多少"和"不放差多少"哪个小。
 * - 一段本身就超过 900 词 → 自己一组。
 * - 章尾剩下 <300 词的小尾巴：和前一组合起来 ≤1000 就并进去，否则两组重新在段落边界上对半分。
 * - 整章不到 600 词 → 一组。
 */
import { chapterParas, type ReaderDB } from '../db/db';
import { ANNOTATE_PROMPT_VERSION } from '../llm/prompts/annotate';
import type { ChunkRow, Para, ReaderLevel } from '../types';
import { wordCount } from './text';

export const CHUNK_MIN = 600;
export const CHUNK_MAX = 900;
const TAIL_MIN = 300;
const TAIL_MERGE_MAX = 1000;

/** 把一章的段落（已按段号排好）分成若干组，返回每组的段落编号。 */
export function planChunks(paras: Pick<Para, 'id' | 'text'>[], min = CHUNK_MIN, max = CHUNK_MAX): string[][] {
  const groups: { ids: string[]; words: number }[] = [];
  let cur: { ids: string[]; words: number } = { ids: [], words: 0 };
  for (const p of paras) {
    const w = wordCount(p.text);
    if (cur.ids.length && cur.words + w > max) {
      const over = cur.words + w - max;
      const under = min - cur.words;
      if (cur.words >= min || under <= over) {
        groups.push(cur);
        cur = { ids: [], words: 0 };
      }
    }
    cur.ids.push(p.id);
    cur.words += w;
  }
  if (cur.ids.length) groups.push(cur);

  // 章尾小尾巴
  if (groups.length >= 2) {
    const tail = groups[groups.length - 1]!;
    const prev = groups[groups.length - 2]!;
    if (tail.words < TAIL_MIN) {
      if (prev.words + tail.words <= TAIL_MERGE_MAX) {
        prev.ids.push(...tail.ids);
        prev.words += tail.words;
        groups.pop();
      } else {
        const both = [...prev.ids, ...tail.ids];
        const wc = new Map(paras.map((p) => [p.id, wordCount(p.text)]));
        const total = prev.words + tail.words;
        let best = 1;
        let bestDiff = Infinity;
        let acc = 0;
        for (let i = 0; i < both.length - 1; i++) {
          acc += wc.get(both[i]!) ?? 0;
          const diff = Math.abs(total - 2 * acc);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = i + 1;
          }
        }
        const a = both.slice(0, best);
        const b = both.slice(best);
        const sum = (ids: string[]) => ids.reduce((s, id) => s + (wc.get(id) ?? 0), 0);
        groups.splice(groups.length - 2, 2, { ids: a, words: sum(a) }, { ids: b, words: sum(b) });
      }
    }
  }
  return groups.map((g) => g.ids);
}

/** 某章已有的组（按章内顺序）。用主键前缀查：chunkId 都是 "c03p…" 开头。 */
export async function chapterChunks(d: ReaderDB, bookId: string, chapter: number): Promise<ChunkRow[]> {
  const prefix = `c${String(chapter).padStart(2, '0')}p`;
  const rows = await d.chunks
    .where('[bookId+chunkId]')
    .between([bookId, prefix], [bookId, prefix + '￿'], true, true)
    .toArray();
  // 字符串排序对段号（至少 4 位补零）是对的；保险起见按数值再排一次
  return rows.sort((x, y) => Number(x.chunkId.slice(prefix.length)) - Number(y.chunkId.slice(prefix.length)));
}

/**
 * 确保某章的组已经切好并存进 chunks 表（status=todo），返回按顺序的组。
 * 已经切过就原样返回（组的边界一旦定下来就不变，chunkId 稳定，回看不会重标）。
 * 章里没有段落（不存在的章）返回空数组。
 */
export async function ensureChapterChunks(
  d: ReaderDB,
  bookId: string,
  chapter: number,
  levelFloor: ReaderLevel,
  model: string,
): Promise<ChunkRow[]> {
  const existing = await chapterChunks(d, bookId, chapter);
  if (existing.length) return existing;
  const paras = await chapterParas(d, bookId, chapter);
  if (!paras.length) return [];
  const rows: ChunkRow[] = planChunks(paras).map((ids) => ({
    bookId,
    chunkId: ids[0]!,
    paraIds: ids,
    status: 'todo',
    model,
    promptVersion: ANNOTATE_PROMPT_VERSION,
    levelFloor,
  }));
  await d.transaction('rw', d.chunks, async () => {
    // 两个调用同时切同一章时，后到的不覆盖已有（主键相同，内容也相同，put 无害，但别把 done 盖回 todo）
    const again = await chapterChunks(d, bookId, chapter);
    if (!again.length) await d.chunks.bulkPut(rows);
  });
  return chapterChunks(d, bookId, chapter);
}

/** 这一组已经按当前 prompt 版本标好了吗（标好了就不再请求）。 */
export function isChunkDone(c: ChunkRow | undefined): boolean {
  return !!c && c.status === 'done' && c.promptVersion === ANNOTATE_PROMPT_VERSION;
}

/** 书里最大章号（用于预取跨章时判断还有没有下一章）。 */
export async function lastChapter(d: ReaderDB, bookId: string): Promise<number> {
  const last = await d.paras
    .where('[bookId+chapter+idx]')
    .between([bookId, 0, 0], [bookId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])
    .last();
  return last?.chapter ?? 0;
}
