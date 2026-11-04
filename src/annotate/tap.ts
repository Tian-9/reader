/**
 * 点词补注（PLAN 3.1 末段）：她点了一个没标的词 → 只把这个词和它所在的那一句发给 Haiku（短 system），
 * 拿回 {lemma, level, gloss_zh, note_zh}，过守卫，存成一条 vocab 标注（chunkId = "tap"）并记进词库。
 * 已经有标注覆盖这个位置的（包括因为"我会"被藏起来的）不发请求，直接用现成的。
 */
import { TAP_SCHEMA } from '../llm/prompts/annotate';
import { TAP_SYSTEM, buildTapUser } from '../llm/prompts/tap';
import type { Annotation, Level, Para, WordTapDetail } from '../types';
import { overlapIndex, redactOverlap } from './guard';
import { annotationId, callStructured, type AnnotateCtx } from './pipeline';
import { noteTapped } from './words';

export const TAP_CHUNK_ID = 'tap';

/** [start, end) 所在的那一句（按 . ! ? 加空格/引号断句，最长 400 字）。 */
export function sentenceAround(text: string, start: number, end: number): string {
  const isEnd = (i: number) => /[.!?]/.test(text[i] ?? '') && /[\s"'”’)]/.test(text[i + 1] ?? ' ');
  let a = start;
  while (a > 0 && !isEnd(a - 1)) a--;
  let b = end;
  while (b < text.length && !isEnd(b)) b++;
  b = Math.min(text.length, b + 1);
  // 收尾的引号一起带上
  while (b < text.length && /["'”’)]/.test(text[b]!)) b++;
  let s = text.slice(a, b).trim();
  if (s.length > 400) {
    const mid = Math.max(0, start - a - 200);
    s = s.slice(mid, mid + 400);
  }
  return s;
}

/** 这个位置上已有的标注（vocab 优先），没有返回 undefined。 */
export function annotationAt(anns: Annotation[], paraId: string, start: number, end: number): Annotation | undefined {
  const hits = anns.filter((a) => a.paraId === paraId && a.start < end && start < a.end);
  return hits.find((a) => a.kind === 'vocab') ?? hits[0];
}

export async function tapAnnotate(
  ctx: AnnotateCtx,
  bookId: string,
  para: Para,
  tap: WordTapDetail,
): Promise<Annotation> {
  const existing = annotationAt(
    await ctx.d.annotations.where('[bookId+paraId]').equals([bookId, para.id]).toArray(),
    para.id,
    tap.start,
    tap.end,
  );
  if (existing) return existing;

  const surface = para.text.slice(tap.start, tap.end) || tap.surface;
  const sentence = sentenceAround(para.text, tap.start, tap.end);
  const { json, model } = await callStructured(ctx, {
    purpose: 'tap',
    bookId,
    system: [{ type: 'text', text: TAP_SYSTEM }],
    user: buildTapUser(surface, sentence, ctx.settings().level),
    schema: TAP_SCHEMA as unknown as Record<string, unknown>,
  });
  const r = json as { lemma?: string; level?: string; gloss_zh?: string; note_zh?: string };
  const index = overlapIndex([para.text]);
  const fields = { gloss_zh: r.gloss_zh ?? '', note_zh: r.note_zh ?? '' };
  for (const k of Object.keys(fields) as (keyof typeof fields)[]) {
    const g = redactOverlap(fields[k], index);
    if (g.hit) {
      fields[k] = g.text;
      await ctx.d.guardEvents.add({ ts: Date.now(), bookId, purpose: 'tap', kind: 'overlap', paraId: para.id, field: k });
    }
  }
  const level = (['A2', 'B1', 'B2', 'C1', 'C2', '-'].includes(r.level ?? '') ? r.level : '-') as Level;
  const lemma = (r.lemma ?? '').trim() || surface.toLowerCase();
  const ann: Annotation = {
    id: annotationId(bookId, para.id, tap.start, tap.end, 'vocab'),
    bookId,
    chunkId: TAP_CHUNK_ID,
    paraId: para.id,
    kind: 'vocab',
    quote: surface,
    start: tap.start,
    end: tap.end,
    lemma,
    level,
    invented: false,
    funType: '-',
    glossZh: fields.gloss_zh.trim(),
    noteZh: fields.note_zh.trim(),
    model,
    createdAt: Date.now(),
  };
  await ctx.d.annotations.put(ann);
  await noteTapped(ctx.d, { lemma, level, glossZh: ann.glossZh, bookId, paraId: para.id });
  return ann;
}
