/**
 * 每读完一章自动生成前情摘要（PLAN T4）。
 *
 * 触发点（chapterFinished）：本章最后一段出现在屏幕上 = 读完了。"下一章"按钮就在最后一段后面，
 * 所以正常翻章一定先经过这一步；从目录跳着走、没看到最后一段的章不算读完，不生成（她没读的不该进前情）。
 *
 * 生成（summarizeChapter）：按 T3 的分组滚动摘要，每次只发一组（≤900 词左右）+ 已有摘要，见 llm/prompts/summary.ts。
 * 结果过一道输出守卫（和本章原文 ≥8 词重合的换成"（原文略）"），截到 300 字，存 summaries。
 */
import type { ReaderDB } from '../db/db';
import { chapterParas } from '../db/db';
import { planChunks } from '../annotate/chunker';
import { overlapIndex, redactOverlap } from '../annotate/guard';
import { callStructured, type AnnotateCtx } from '../annotate/pipeline';
import { storySoFar } from '../annotate/profile';
import { SUMMARY_MAX_CHARS, SUMMARY_SCHEMA, SUMMARY_SYSTEM, buildSummaryUser } from '../llm/prompts/summary';
import type { Summary } from '../types';

/**
 * 读完这一章了吗：本章最后一段在可见段落里。
 * chapterParaIds 是本章全部段落（按顺序），visibleParaIds 是屏幕上的段落（reading.visibleParaIds）。
 */
export function chapterFinished(chapterParaIds: readonly string[], visibleParaIds: readonly string[]): boolean {
  const last = chapterParaIds[chapterParaIds.length - 1];
  return !!last && visibleParaIds.includes(last);
}

/**
 * 要不要给这一章生成摘要：读完了、还没有摘要、没在生成、有口令。返回要生成的章号或 null。
 * 纯函数，单测直接测；界面里每次可见段落变化时调用。
 */
export function summaryToTrigger(x: {
  chapter: number;
  chapterParaIds: readonly string[];
  visibleParaIds: readonly string[];
  /** 已经有摘要（或正在生成）的章 */
  done: ReadonlySet<number>;
  hasToken: boolean;
}): number | null {
  if (!x.hasToken || x.chapter <= 0 || x.done.has(x.chapter)) return null;
  return chapterFinished(x.chapterParaIds, x.visibleParaIds) ? x.chapter : null;
}

/** 前情里给 Haiku 认人名用的前几章摘要（短一点就够）。 */
const EARLIER_MAX = 400;

export async function summarizeChapter(
  ctx: AnnotateCtx,
  bookId: string,
  chapter: number,
  chapterTitle = `第${chapter}章`,
): Promise<Summary | null> {
  const { d } = ctx;
  const paras = await chapterParas(d, bookId, chapter);
  if (!paras.length) return null;
  const groups = planChunks(paras);
  const byId = new Map(paras.map((p) => [p.id, p]));
  const index = overlapIndex(paras.map((p) => p.text));
  const earlier = await storySoFar(d, bookId, chapter, EARLIER_MAX);
  let soFar = '';
  let model = '';
  for (const ids of groups) {
    const part = ids.map((id) => byId.get(id)!).filter(Boolean);
    const { json, model: m } = await callStructured(ctx, {
      purpose: 'summary',
      bookId,
      system: [{ type: 'text', text: SUMMARY_SYSTEM }],
      user: buildSummaryUser({ chapterTitle, earlier, soFar, paras: part }),
      schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    });
    model = m;
    const raw = typeof (json as { summary?: unknown }).summary === 'string' ? (json as { summary: string }).summary : '';
    if (raw.trim()) soFar = raw.trim();
  }
  const g = redactOverlap(soFar, index);
  if (g.hit) await d.guardEvents.add({ ts: Date.now(), bookId, purpose: 'summary', kind: 'overlap', field: 'summary' });
  const row: Summary = { bookId, chapter, textZh: g.text.slice(0, SUMMARY_MAX_CHARS), model };
  await d.summaries.put(row);
  ctx.log?.(`[summary] 第${chapter}章摘要好了（${groups.length} 次调用，${row.textZh.length} 字）`);
  return row;
}

/** 同一章只生成一次（并发去重；已有摘要的直接跳过）。 */
export class Summarizer {
  private inflight = new Map<string, Promise<Summary | null>>();
  /** 实际发起生成的次数（验收用） */
  runs = 0;

  constructor(readonly ctx: AnnotateCtx) {}

  ensure(bookId: string, chapter: number, chapterTitle?: string): Promise<Summary | null> {
    const key = `${bookId}|${chapter}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const task = (async () => {
      const have = await this.ctx.d.summaries.get([bookId, chapter]);
      if (have) return have;
      this.runs++;
      return summarizeChapter(this.ctx, bookId, chapter, chapterTitle);
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /** 已有摘要的章号（界面用来跳过触发） */
  async doneChapters(d: ReaderDB, bookId: string): Promise<Set<number>> {
    const rows = await d.summaries.where('bookId').equals(bookId).toArray();
    return new Set([...rows.map((r) => r.chapter), ...[...this.inflight.keys()].filter((k) => k.startsWith(bookId + '|')).map((k) => Number(k.split('|')[1]))]);
  }
}
