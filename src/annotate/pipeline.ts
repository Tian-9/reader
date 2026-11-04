/**
 * 标注管线（PLAN T3）：一组段落 → 拼请求 → structured outputs 调用（Haiku 被拒用 Sonnet 重试一次）
 * → 解析 → 锚定 → 输出守卫 → 存 annotations、更新 chunks、记账本和守卫记录。
 *
 * 调 API 的函数从外面传进来（CreateFn）：浏览器里是走代理的 SDK 客户端（见 queue.ts 的 browserCreate），
 * 本地真跑脚本里是直连的 SDK，单测里是假的。这里不关心是哪一种。
 */
import type { Message, MessageCreateParamsNonStreaming, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { ReaderDB } from '../db/db';
import { baseParams } from '../llm/client';
import { recordUsage } from '../llm/ledger';
import { ANNOTATE_PROMPT_VERSION, ANNOTATE_SCHEMA, ANNOTATE_SYSTEM } from '../llm/prompts/annotate';
import { REFUSAL_RETRY_MODEL, type ModelId } from '../llm/roles';
import {
  parseParaId,
  type Annotation,
  type AnnotationItem,
  type ChunkRow,
  type ChunkStats,
  type GuardEvent,
  type Purpose,
  type Settings,
} from '../types';
import { resolveAnchor } from './anchor';
import { overlapIndex, redactOverlap } from './guard';
import { alreadyNoted, buildAnnotateUser, knownFromUser, knownSample, storySoFar, unknownSample } from './profile';
import { levelFloor } from './visible';

export type CreateFn = (params: MessageCreateParamsNonStreaming) => Promise<Message>;

export interface AnnotateCtx {
  d: ReaderDB;
  create: CreateFn;
  /** 每次调用时现读（设置可能中途改了） */
  settings: () => Pick<Settings, 'level' | 'models'>;
  /** 调试日志。默认只打 <known> 样本和统计，不打正文。 */
  log?: (msg: string, data?: unknown) => void;
}

export class RefusedError extends Error {
  constructor(model: string) {
    super(`模型拒绝了这段（${model}）`);
    this.name = 'RefusedError';
  }
}

export class TruncatedError extends Error {
  constructor() {
    super('输出被 max_tokens 截断，JSON 不完整');
    this.name = 'TruncatedError';
  }
}

function textOf(msg: Message): string {
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

async function guardEvent(d: ReaderDB, e: Omit<GuardEvent, 'ts'>): Promise<void> {
  await d.guardEvents.add({ ts: Date.now(), ...e });
}

/**
 * 发一次 structured outputs 请求；Haiku 返回 stop_reason=refusal 时用 REFUSAL_RETRY_MODEL 重试一次。
 * 每次真实调用都记账本（被拒的那次也花了钱）。
 */
export async function callStructured(
  ctx: AnnotateCtx,
  o: {
    purpose: Purpose;
    bookId: string;
    system: TextBlockParam[];
    user: string;
    schema: Record<string, unknown>;
    model?: ModelId;
  },
): Promise<{ json: unknown; model: string; retried: boolean }> {
  const s = ctx.settings();
  const send = async (model?: ModelId) => {
    const p = baseParams(o.purpose, s, model);
    const msg = await ctx.create({
      ...p,
      system: o.system,
      messages: [{ role: 'user', content: o.user }],
      output_config: { ...p.output_config, format: { type: 'json_schema', schema: o.schema } },
    });
    await recordUsage(ctx.d, { purpose: o.purpose, model: msg.model || p.model, usage: msg.usage, bookId: o.bookId });
    return { msg, model: p.model };
  };
  let { msg, model } = await send(o.model);
  let retried = false;
  if (msg.stop_reason === 'refusal') {
    await guardEvent(ctx.d, { bookId: o.bookId, purpose: o.purpose, kind: 'refusal' });
    if (model !== 'claude-haiku-5-5') throw new RefusedError(model);
    ctx.log?.(`[${o.purpose}] Haiku 拒绝，用 ${REFUSAL_RETRY_MODEL} 重试一次`);
    ({ msg, model } = await send(REFUSAL_RETRY_MODEL));
    retried = true;
    if (msg.stop_reason === 'refusal') throw new RefusedError(model);
  }
  if (msg.stop_reason === 'max_tokens') throw new TruncatedError();
  return { json: JSON.parse(textOf(msg)), model, retried };
}

/** 模型条目的形状检查（structured outputs 基本保证了，这里防个万一）。 */
function isItem(x: unknown): x is AnnotationItem {
  const o = x as Record<string, unknown>;
  return (
    !!o &&
    (o.kind === 'vocab' || o.kind === 'fun') &&
    typeof o.p === 'string' &&
    typeof o.quote === 'string' &&
    typeof o.occ === 'number' &&
    typeof o.lemma === 'string' &&
    typeof o.level === 'string' &&
    typeof o.gloss_zh === 'string' &&
    typeof o.note_zh === 'string'
  );
}

export function annotationId(bookId: string, paraId: string, start: number, end: number, kind: string): string {
  return `${bookId.slice(0, 16)}|${paraId}|${start}-${end}|${kind}`;
}

export interface ProcessResult {
  rows: Annotation[];
  stats: Omit<ChunkStats, 'refusalRetried'>;
  events: Omit<GuardEvent, 'ts'>[];
}

/**
 * 纯函数部分：模型条目 → 锚定 + 守卫 → 可入库的 Annotation。单测直接测这个。
 * 丢弃：段落编号不在本组 / 找不到 / quote 超 5 词。替换：文本字段与本组段落 ≥8 词重合。
 */
export function processItems(
  items: unknown[],
  paras: { id: string; text: string }[],
  meta: { bookId: string; chunkId: string; model: string; now?: number },
): ProcessResult {
  const byId = new Map(paras.map((p) => [p.id, p.text]));
  const index = overlapIndex(paras.map((p) => p.text));
  const stats = { items: items.length, stored: 0, anchorFail: 0, quoteTooLong: 0, occFallback: 0, overlapHits: 0 };
  const events: Omit<GuardEvent, 'ts'>[] = [];
  const out = new Map<string, Annotation>();
  const ev = (kind: GuardEvent['kind'], paraId?: string, field?: string) =>
    events.push({ bookId: meta.bookId, purpose: 'annotate', kind, paraId, field });

  for (const raw of items) {
    if (!isItem(raw)) {
      stats.anchorFail++;
      ev('anchor-fail');
      continue;
    }
    const text = byId.get(raw.p);
    if (text === undefined) {
      stats.anchorFail++;
      ev('anchor-fail', raw.p);
      continue;
    }
    const r = resolveAnchor(text, raw.quote, raw.occ);
    if (!r.ok) {
      if (r.reason === 'too-long') {
        stats.quoteTooLong++;
        ev('quote-too-long', raw.p, 'quote');
      } else {
        stats.anchorFail++;
        ev('anchor-fail', raw.p);
      }
      continue;
    }
    if (r.occFallback) stats.occFallback++;
    const fields = { lemma: raw.lemma, gloss_zh: raw.gloss_zh, note_zh: raw.note_zh };
    for (const k of Object.keys(fields) as (keyof typeof fields)[]) {
      const g = redactOverlap(fields[k], index);
      if (g.hit) {
        fields[k] = g.text;
        stats.overlapHits++;
        ev('overlap', raw.p, k);
      }
    }
    const id = annotationId(meta.bookId, raw.p, r.start, r.end, raw.kind);
    if (out.has(id)) continue;
    out.set(id, {
      id,
      bookId: meta.bookId,
      chunkId: meta.chunkId,
      paraId: raw.p,
      kind: raw.kind,
      quote: text.slice(r.start, r.end),
      start: r.start,
      end: r.end,
      lemma: raw.kind === 'vocab' ? fields.lemma.trim() : '',
      level: raw.level,
      invented: !!raw.invented,
      funType: raw.fun_type,
      glossZh: fields.gloss_zh.trim(),
      noteZh: fields.note_zh.trim(),
      model: meta.model,
      createdAt: meta.now ?? Date.now(),
    });
  }
  stats.stored = out.size;
  return { rows: [...out.values()], stats, events };
}

/**
 * 标一组。成功后 chunk.status=done（带统计），失败 status=error 并抛出。
 * opts.model 用来做对照（比如同一组用 Sonnet 跑一遍）；不传就按设置/roles.ts。
 */
export async function annotateChunk(
  ctx: AnnotateCtx,
  chunk: ChunkRow,
  opts: { model?: ModelId } = {},
): Promise<ChunkStats> {
  const { d } = ctx;
  const s = ctx.settings();
  const chapter = parseParaId(chunk.chunkId)?.chapter ?? 0;
  const paras = (await d.paras.bulkGet(chunk.paraIds.map((id) => [chunk.bookId, id] as [string, string]))).filter(
    (p): p is NonNullable<typeof p> => !!p,
  );
  const words = await d.words.toArray();
  const floor = levelFloor(s.level);
  const user = buildAnnotateUser({
    level: s.level,
    floor,
    known: knownSample(words, s.level),
    unknown: unknownSample(words),
    story: await storySoFar(d, chunk.bookId, chapter),
    noted: await alreadyNoted(d, chunk.bookId, chapter, chunk.chunkId),
    paras,
  });
  ctx.log?.(`[annotate] 请求 ${chunk.chunkId}`, { known: knownFromUser(user) });

  try {
    const { json, model, retried } = await callStructured(ctx, {
      purpose: 'annotate',
      bookId: chunk.bookId,
      system: [{ type: 'text', text: ANNOTATE_SYSTEM, cache_control: { type: 'ephemeral' } }],
      user,
      schema: ANNOTATE_SCHEMA as unknown as Record<string, unknown>,
      model: opts.model,
    });
    const items = (json as { items?: unknown }).items;
    const { rows, stats, events } = processItems(Array.isArray(items) ? items : [], paras, {
      bookId: chunk.bookId,
      chunkId: chunk.chunkId,
      model,
    });
    const full: ChunkStats = { ...stats, refusalRetried: retried };
    await d.transaction('rw', [d.annotations, d.chunks, d.guardEvents], async () => {
      const old = await d.annotations.where('chunkId').equals(chunk.chunkId).filter((a) => a.bookId === chunk.bookId).primaryKeys();
      await d.annotations.bulkDelete(old);
      await d.annotations.bulkPut(rows);
      const ts = Date.now();
      if (events.length) await d.guardEvents.bulkAdd(events.map((e) => ({ ts, ...e })));
      await d.chunks.put({ ...chunk, status: 'done', model, promptVersion: ANNOTATE_PROMPT_VERSION, levelFloor: floor, stats: full });
    });
    ctx.log?.(`[annotate] 完成 ${chunk.chunkId}`, full);
    return full;
  } catch (e) {
    await d.chunks.put({ ...chunk, status: 'error' });
    throw e;
  }
}
