import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annotateChunk, type AnnotateCtx } from '../src/annotate/pipeline';
import { knownFromUser } from '../src/annotate/profile';
import { Annotator } from '../src/annotate/queue';
import { isVisible } from '../src/annotate/visible';
import { lemmaSets, markKnown, thresholdHint } from '../src/annotate/words';
import { ReaderDB } from '../src/db/db';
import { totalUsd } from '../src/llm/ledger';
import type { Settings } from '../src/types';
import { BOOK, CH1, fakeMessage, filler, item, rows } from './fixtures/t3';

let d: ReaderDB;
let calls: MessageCreateParamsNonStreaming[];
let replies: ((p: MessageCreateParamsNonStreaming) => ReturnType<typeof fakeMessage>)[];
const settings: Pick<Settings, 'level' | 'models'> = { level: 'B1', models: {} };

/** 默认回复：对每组的第一段标一个 vocab（quote 取首段第 2 个词）+ 第一段里 "sideways"（如果有）。 */
function defaultReply(p: MessageCreateParamsNonStreaming) {
  const user = String(p.messages[0]!.content);
  const first = /\[(c\d+p\d+)\] (\S+) (\S+)/.exec(user)!;
  return fakeMessage({ items: [item({ p: first[1], quote: first[3], lemma: first[3]!.toLowerCase(), level: 'C1', gloss_zh: '某个意思' })] });
}

function ctx(): AnnotateCtx {
  return {
    d,
    settings: () => settings,
    create: async (p) => {
      calls.push(p);
      const r = replies.shift() ?? defaultReply;
      return r(p);
    },
  };
}

beforeEach(() => {
  calls = [];
  replies = [];
});
afterEach(async () => {
  await d?.delete();
});

describe('annotateChunk', () => {
  it('请求形状：structured outputs + 缓存的 system + user 按模板顺序；结果入库、记账', async () => {
    d = new ReaderDB('t-pipe-1');
    await d.paras.bulkPut(rows(1, CH1));
    await d.summaries.put({ bookId: BOOK, chapter: 1, textZh: '不该出现（本章自己的摘要不算前情）', model: 'x' });
    replies.push(() =>
      fakeMessage({
        items: [
          item({ quote: 'approved of', lemma: 'approve of', level: 'B1', gloss_zh: '认可' }),
          item({ p: 'c01p0002', quote: '"Lovely weather,"', kind: 'fun', level: '-', fun_type: '英式表达', note_zh: '反话' }),
          item({ p: 'c01p0002', quote: 'sideways', lemma: 'sideways', level: 'B2', gloss_zh: '横着' }),
          item({ p: 'c01p0003', quote: 'grumpy kettle', lemma: 'grumpy' }), // 找不到
        ],
      }),
    );
    const chunk = { bookId: BOOK, chunkId: 'c01p0001', paraIds: CH1.map((_, i) => `c01p000${i + 1}`), status: 'todo' as const, model: 'claude-haiku-5-5', promptVersion: 1, levelFloor: 'A2' as const };
    await d.chunks.put(chunk);
    const stats = await annotateChunk(ctx(), chunk);

    const p = calls[0]!;
    expect(p.model).toBe('claude-haiku-5-5');
    expect(p.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    expect(p.thinking).toEqual({ type: 'adaptive' });
    expect((p.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
    const user = String(p.messages[0]!.content);
    const order = ['<reader_profile>', '<known>', '<unknown>', '<story_so_far>', '<already_noted>', '<passage>', '[c01p0001]', '[c01p0004]'].map((t) => user.indexOf(t));
    expect(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1]!))).toBe(true);
    expect(user).toContain('水平自评：B1；标注下限：A2');
    expect(user).toContain('<story_so_far></story_so_far>');

    expect(stats).toMatchObject({ items: 4, stored: 3, anchorFail: 1, refusalRetried: false });
    const anns = await d.annotations.where('chunkId').equals('c01p0001').toArray();
    expect(anns.map((a) => a.quote).sort()).toEqual(['approved of', 'sideways', '“Lovely weather,”'].sort());
    const fresh = await d.chunks.get([BOOK, 'c01p0001']);
    expect(fresh).toMatchObject({ status: 'done', model: 'claude-haiku-5-5' });
    const ledger = await d.ledger.toArray();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ purpose: 'annotate', model: 'claude-haiku-5-5', input: 2000, output: 1500, cacheRead: 2500 });
    // 2000×0.1 + 1500×0.5 + 2500×0.01 = 975 美元/百万 → 0.000975
    expect(await totalUsd(d, BOOK)).toBeCloseTo(0.000975, 9);
    expect(await d.guardEvents.where('kind').equals('anchor-fail').count()).toBe(1);
  });

  it('Haiku 被拒 → 用 Sonnet 重试一次，两次都记账', async () => {
    d = new ReaderDB('t-pipe-2');
    await d.paras.bulkPut(rows(1, CH1));
    replies.push(() => fakeMessage(null, { stop: 'refusal' }));
    replies.push(() => fakeMessage({ items: [item({ quote: 'nothing', lemma: 'nothing' })] }, { model: 'claude-sonnet-5-5' }));
    const chunk = { bookId: BOOK, chunkId: 'c01p0001', paraIds: ['c01p0001'], status: 'todo' as const, model: 'claude-haiku-5-5', promptVersion: 1, levelFloor: 'A2' as const };
    const stats = await annotateChunk(ctx(), chunk);
    expect(calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(stats.refusalRetried).toBe(true);
    expect((await d.chunks.get([BOOK, 'c01p0001']))?.model).toBe('claude-sonnet-5-5');
    expect((await d.ledger.toArray()).map((l) => l.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(await d.guardEvents.where('kind').equals('refusal').count()).toBe(1);
  });

  it('两次都被拒 → chunk 记 error 并抛出', async () => {
    d = new ReaderDB('t-pipe-3');
    await d.paras.bulkPut(rows(1, CH1));
    replies.push(() => fakeMessage(null, { stop: 'refusal' }), () => fakeMessage(null, { stop: 'refusal' }));
    const chunk = { bookId: BOOK, chunkId: 'c01p0001', paraIds: ['c01p0001'], status: 'todo' as const, model: 'claude-haiku-5-5', promptVersion: 1, levelFloor: 'A2' as const };
    await expect(annotateChunk(ctx(), chunk)).rejects.toThrow(/拒绝/);
    expect((await d.chunks.get([BOOK, 'c01p0001']))?.status).toBe('error');
  });

  it('输出被 max_tokens 截断（思考吃光预算）→ effort=low 重发一次，两次都记账', async () => {
    d = new ReaderDB('t-pipe-4');
    await d.paras.bulkPut(rows(1, CH1));
    replies.push(() => fakeMessage(null, { stop: 'max_tokens' }));
    replies.push(() => fakeMessage({ items: [item({ quote: 'nothing', lemma: 'nothing' })] }));
    const chunk = { bookId: BOOK, chunkId: 'c01p0001', paraIds: ['c01p0001'], status: 'todo' as const, model: 'claude-haiku-5-5', promptVersion: 1, levelFloor: 'A2' as const };
    const stats = await annotateChunk(ctx(), chunk);
    expect(calls.map((c) => c.output_config?.effort)).toEqual(['medium', 'low']);
    expect(calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5']);
    expect(stats.stored).toBe(1);
    expect(await d.ledger.count()).toBe(2);
  });

  it('low 也截断 → chunk 记 error 并抛 TruncatedError', async () => {
    d = new ReaderDB('t-pipe-5');
    await d.paras.bulkPut(rows(1, CH1));
    replies.push(() => fakeMessage(null, { stop: 'max_tokens' }), () => fakeMessage(null, { stop: 'max_tokens' }));
    const chunk = { bookId: BOOK, chunkId: 'c01p0001', paraIds: ['c01p0001'], status: 'todo' as const, model: 'claude-haiku-5-5', promptVersion: 1, levelFloor: 'A2' as const };
    await expect(annotateChunk(ctx(), chunk)).rejects.toThrow(/截断/);
    expect(calls).toHaveLength(2);
    expect((await d.chunks.get([BOOK, 'c01p0001']))?.status).toBe('error');
  });
});

describe('预取队列', () => {
  async function seedBook() {
    // 3 章，每章 20 段 × 90 词 ≈ 1800 词 → 每章 2–3 组
    for (const ch of [1, 2, 3]) await d.paras.bulkPut(rows(ch, Array.from({ length: 20 }, (_, i) => filler(90, i + ch))));
  }

  it('读到 k：k、k+1 等完，k+2 后台发；回看已标章节 0 次调用', async () => {
    d = new ReaderDB('t-queue-1');
    await seedBook();
    const a = new Annotator(ctx());
    await a.ensureAround(BOOK, 'c01p0001');
    // k、k+1 已完成；k+2 可能还在路上，等队列排空
    const chunks = await a.chunksFrom(BOOK, 'c01p0001', 3);
    await Promise.all(chunks.map((c) => a.ensure(c)));
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => /\[(c\d+p\d+)\]/.exec(String(c.messages[0]!.content))![1])).size).toBe(3);

    // 回看第 1 章开头、中间：0 次新调用
    const before = calls.length;
    await a.ensureAround(BOOK, 'c01p0001');
    await a.ensureAround(BOOK, chunks[0]!.paraIds[1]!);
    expect(calls.length).toBe(before);

    // 换一个新的 Annotator（模拟重开 App）：状态在库里，照样 0 次
    const b = new Annotator(ctx());
    await b.ensureAround(BOOK, 'c01p0001');
    expect(calls.length).toBe(before);
    expect(b.runs).toBe(0);
  });

  it('本章最后一组的 k+1 是下一章第一组', async () => {
    d = new ReaderDB('t-queue-2');
    await seedBook();
    const a = new Annotator(ctx());
    const ch1 = await a.chunksFrom(BOOK, 'c01p0001', 10);
    const lastOfCh1 = ch1.filter((c) => c.chunkId.startsWith('c01')).at(-1)!;
    const next = await a.chunksFrom(BOOK, lastOfCh1.paraIds.at(-1)!, 2);
    expect(next.map((c) => c.chunkId)).toEqual([lastOfCh1.chunkId, 'c02p0001']);
  });

  it('同一组同时要两次只发一次', async () => {
    d = new ReaderDB('t-queue-3');
    await seedBook();
    const a = new Annotator(ctx());
    const [k] = await a.chunksFrom(BOOK, 'c02p0001', 1);
    await Promise.all([a.ensure(k!), a.ensure(k!), a.ensure(k!)]);
    expect(calls).toHaveLength(1);
  });

  it('后一组的 <already_noted> 带上前一组标过的 lemma', async () => {
    d = new ReaderDB('t-queue-4');
    await seedBook();
    const a = new Annotator(ctx());
    const [k, k1] = await a.chunksFrom(BOOK, 'c01p0001', 2);
    await a.ensure(k!);
    await a.ensure(k1!);
    const u2 = String(calls[1]!.messages[0]!.content);
    const noted = /<already_noted>(.*)<\/already_noted>/.exec(u2)![1]!;
    expect(noted.length).toBeGreaterThan(0);
  });
});

describe('"这个我会"', () => {
  it('全书同 lemma 立刻不显示；下一次请求的 <known> 里有它', async () => {
    d = new ReaderDB('t-known');
    await d.paras.bulkPut(rows(1, CH1));
    await d.paras.bulkPut(rows(2, ['Sideways again, the rain went sideways all afternoon.']));
    await d.annotations.bulkPut([
      { id: 'a1', bookId: BOOK, chunkId: 'c01p0001', paraId: 'c01p0002', kind: 'vocab', quote: 'sideways', start: 0, end: 1, lemma: 'sideways', level: 'B2', invented: false, funType: '-', glossZh: '横着', noteZh: '', model: 'm', createdAt: 1 },
      { id: 'a2', bookId: BOOK, chunkId: 'c02p0001', paraId: 'c02p0001', kind: 'vocab', quote: 'Sideways', start: 0, end: 8, lemma: 'Sideways', level: 'B2', invented: false, funType: '-', glossZh: '侧着', noteZh: '', model: 'm', createdAt: 1 },
    ]);
    const visibleCount = async () => {
      const { known, marked } = lemmaSets(await d.words.toArray());
      return (await d.annotations.toArray()).filter((a) => isVisible(a, 'B1', known, marked)).length;
    };
    expect(await visibleCount()).toBe(2);
    await markKnown(d, { lemma: 'sideways', level: 'B2', bookId: BOOK, paraId: 'c01p0002' });
    expect(await visibleCount()).toBe(0);

    const logs: unknown[] = [];
    const c = { ...ctx(), log: (_m: string, x?: unknown) => logs.push(x) };
    const chunk = { bookId: BOOK, chunkId: 'c01p0001', paraIds: ['c01p0001'], status: 'todo' as const, model: 'claude-haiku-5-5', promptVersion: 1, levelFloor: 'A2' as const };
    await annotateChunk(c, chunk);
    expect(knownFromUser(String(calls[0]!.messages[0]!.content))).toContain('sideways');
    expect(logs[0]).toEqual({ known: ['sideways'] });
  });

  it('阈值过滤：B1 读者只看 B2 以上；fun、自造词、在学的词照常显示', () => {
    const known = new Set<string>();
    const marked = new Set(['approve of']);
    const base = { kind: 'vocab' as const, invented: false };
    expect(isVisible({ ...base, lemma: 'stare', level: 'B1' }, 'B1', known, marked)).toBe(false);
    expect(isVisible({ ...base, lemma: 'sideways', level: 'B2' }, 'B1', known, marked)).toBe(true);
    expect(isVisible({ ...base, lemma: 'approve of', level: 'A2' }, 'B1', known, marked)).toBe(true);
    expect(isVisible({ ...base, lemma: 'muggle', level: 'B1', invented: true }, 'B1', known, marked)).toBe(true);
    expect(isVisible({ kind: 'fun', lemma: '', level: '-', invented: false }, 'C2', known, marked)).toBe(true);
  });

  it('同一级连点 15 次"我会" → 提示调阈值（只提示）；中间夹别的级别就重新数', async () => {
    d = new ReaderDB('t-hint');
    for (let i = 0; i < 14; i++) await markKnown(d, { lemma: `w${i}`, level: 'B2', bookId: BOOK, paraId: 'c01p0001' });
    expect(thresholdHint(await d.words.toArray(), 'B1')).toBeNull();
    await markKnown(d, { lemma: 'w14', level: 'B2', bookId: BOOK, paraId: 'c01p0001' });
    expect(thresholdHint(await d.words.toArray(), 'B1')).toEqual({ level: 'B2', count: 15, suggest: 'B2' });
    expect(thresholdHint(await d.words.toArray(), 'B2')).toBeNull();
    await markKnown(d, { lemma: 'x', level: 'C1', bookId: BOOK, paraId: 'c01p0001' });
    expect(thresholdHint(await d.words.toArray(), 'B1')).toBeNull();
  });
});
