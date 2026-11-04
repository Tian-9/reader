/**
 * 预取队列（PLAN 3.1）：她读到第 k 组时，确保 k、k+1 已标好（等它们），并在后台请求 k+2。
 * - 已标过的组（status=done 且 prompt 版本一致）不再请求 → 回看已标章节 0 次调用
 * - 同一本书的请求排成一队、一个一个发：后一组的 <already_noted> 要用到前一组的结果，也免得一下子打一串
 * - 同一组同时被要两次只发一次（inflight 去重）
 * - 组可以跨章：本章最后一组的 k+1 是下一章第一组
 */
import { db } from '../db/db';
import { getClient } from '../llm/client';
import { modelFor } from '../llm/roles';
import { parseParaId, type ChunkRow, type Settings } from '../types';
import { ensureChapterChunks, isChunkDone, lastChapter } from './chunker';
import { annotateChunk, type AnnotateCtx, type CreateFn } from './pipeline';
import { levelFloor } from './visible';

export class Annotator {
  private chains = new Map<string, Promise<unknown>>();
  private inflight = new Map<string, Promise<void>>();
  /** 本会话实际发出的标注任务数（验收"回看 0 次调用"用） */
  runs = 0;

  constructor(readonly ctx: AnnotateCtx) {}

  /** 从 paraId 所在的组开始，往后取 count 组（跨章）。 */
  async chunksFrom(bookId: string, paraId: string, count: number): Promise<ChunkRow[]> {
    const pos = parseParaId(paraId);
    if (!pos) return [];
    const { d } = this.ctx;
    const s = this.ctx.settings();
    const floor = levelFloor(s.level);
    const model = modelFor('annotate', s);
    const last = await lastChapter(d, bookId);
    const out: ChunkRow[] = [];
    let chapter = pos.chapter;
    let started = false;
    while (out.length < count && chapter <= last) {
      const rows = await ensureChapterChunks(d, bookId, chapter, floor, model);
      for (const c of rows) {
        if (!started) {
          // 组里包含 paraId，或者 paraId 落在两组之间（理论上不会）时取下一组
          if (c.paraIds.includes(paraId)) started = true;
          else continue;
        }
        out.push(c);
        if (out.length >= count) break;
      }
      if (!started) started = true; // paraId 不在这一章的任何组里：从下一章开头接着取
      chapter++;
    }
    return out;
  }

  /** 确保这一组标好（已标好立即返回，不发请求）。 */
  ensure(chunk: ChunkRow): Promise<void> {
    if (isChunkDone(chunk)) return Promise.resolve();
    const key = `${chunk.bookId}|${chunk.chunkId}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const prev = this.chains.get(chunk.bookId) ?? Promise.resolve();
    const task = prev
      .catch(() => undefined)
      .then(async () => {
        const fresh = await this.ctx.d.chunks.get([chunk.bookId, chunk.chunkId]);
        if (isChunkDone(fresh)) return;
        this.runs++;
        await annotateChunk(this.ctx, fresh ?? chunk);
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    this.chains.set(chunk.bookId, task);
    return task;
  }

  /**
   * 读到 paraId：等 k、k+1，后台发 k+2。
   * onPending：k、k+1 里还没标好的组（一开始报一次，每标好一组再报一次，最后是 []）。界面拿它和屏幕上的段落比，
   * 决定显示"标注中…"还是"预取下一段"（见 pillState）。k+2 是后台的，不报。
   */
  async ensureAround(bookId: string, paraId: string, onPending?: (pending: ChunkRow[]) => void): Promise<void> {
    const [k, k1, k2] = await this.chunksFrom(bookId, paraId, 3);
    const must = [k, k1].filter((c): c is ChunkRow => !!c);
    let pending = must.filter((c) => !isChunkDone(c));
    onPending?.(pending);
    const tasks = must.map((c) =>
      this.ensure(c).then(() => {
        if (!pending.includes(c)) return;
        pending = pending.filter((x) => x !== c);
        onPending?.(pending);
      }),
    );
    if (k2) this.ensure(k2).catch((e) => this.ctx.log?.('[annotate] 后台预取失败', String(e)));
    try {
      await Promise.all(tasks);
    } finally {
      if (pending.length) onPending?.([]);
    }
  }
}

/**
 * 右下角小牌子的状态：
 * - 'current'：屏幕上看得见的段落还有没标好的 → "标注中…"
 * - 'prefetch'：看得见的都标好了，只是在等下一组 → 不打扰的"预取下一段"小字
 * - 'idle'：都好了，不显示
 */
export type PillState = 'current' | 'prefetch' | 'idle';

export function pillState(pending: Pick<ChunkRow, 'paraIds'>[], visibleParaIds: readonly string[]): PillState {
  if (!pending.length) return 'idle';
  const vis = new Set(visibleParaIds);
  return pending.some((c) => c.paraIds.some((p) => vis.has(p))) ? 'current' : 'prefetch';
}

/** 浏览器里用：拿设置里的 key 直连 Anthropic。SDK 在第一次真的要发请求时才加载（全部已标好时连 SDK 都不下载）。 */
export function browserCreate(getKey: () => string): CreateFn {
  return async (params) => (await getClient(getKey())).messages.create(params);
}

let shared: Annotator | null = null;

/** 全局唯一的标注器（阅读页用）。settings 传 getter，改了设置下一次请求就生效。 */
export function getAnnotator(settings: () => Settings): Annotator {
  shared ??= new Annotator({
    d: db(),
    create: browserCreate(() => settings().apiKey),
    settings,
    log: (m, x) => console.debug(m, x ?? ''),
  });
  return shared;
}
