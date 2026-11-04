import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnnotateCtx } from '../src/annotate/pipeline';
import { wordCount } from '../src/annotate/text';
import { Summarizer, chapterFinished, summarizeChapter, summaryToTrigger } from '../src/chat/summary';
import { ReaderDB } from '../src/db/db';
import { SUMMARY_MAX_CHARS } from '../src/llm/prompts/summary';
import { BOOK, CH1, fakeMessage, filler, rows } from './fixtures/t3';

describe('章末触发', () => {
  const ids = ['c03p0001', 'c03p0002', 'c03p0003'];
  const base = { chapter: 3, chapterParaIds: ids, done: new Set<number>(), hasToken: true };

  it('最后一段在屏幕上 = 读完', () => {
    expect(chapterFinished(ids, ['c03p0002', 'c03p0003'])).toBe(true);
    expect(chapterFinished(ids, ['c03p0001', 'c03p0002'])).toBe(false);
    expect(chapterFinished([], ['c03p0001'])).toBe(false);
  });

  it('读到章末 → 触发本章', () => {
    expect(summaryToTrigger({ ...base, visibleParaIds: ['c03p0003'] })).toBe(3);
  });

  it('还没到章末 → 不触发', () => {
    expect(summaryToTrigger({ ...base, visibleParaIds: ['c03p0001', 'c03p0002'] })).toBeNull();
  });

  it('已有摘要 / 正在生成 → 不再触发', () => {
    expect(summaryToTrigger({ ...base, visibleParaIds: ['c03p0003'], done: new Set([3]) })).toBeNull();
  });

  it('没口令 → 不触发（不发注定失败的请求）', () => {
    expect(summaryToTrigger({ ...base, visibleParaIds: ['c03p0003'], hasToken: false })).toBeNull();
  });

  it('章号无效 → 不触发', () => {
    expect(summaryToTrigger({ ...base, chapter: 0, visibleParaIds: ['c03p0003'] })).toBeNull();
  });
});

describe('生成摘要', () => {
  let d: ReaderDB;
  let calls: MessageCreateParamsNonStreaming[];
  let reply: (p: MessageCreateParamsNonStreaming, i: number) => unknown;

  const ctx = (): AnnotateCtx => ({
    d,
    settings: () => ({ level: 'B1', models: {} }),
    create: async (p) => {
      calls.push(p);
      return fakeMessage(reply(p, calls.length));
    },
  });

  beforeEach(() => {
    calls = [];
    reply = (_p, i) => ({ summary: `摘要第${i}版` });
  });
  afterEach(async () => {
    await d?.delete();
  });

  it('按组滚动：每次只发一组（≤1000 词），带上一版摘要；最后一版入库；记账 purpose=summary', async () => {
    d = new ReaderDB('t-sum-1');
    // 第 2 章：6 段 × 400 词 = 2400 词 → 至少 3 组
    const texts = Array.from({ length: 6 }, (_, i) => filler(400, i));
    await d.paras.bulkPut(rows(2, texts));
    await d.summaries.put({ bookId: BOOK, chapter: 1, textZh: '温迪（Wendy）一家出场。', model: 'x' });
    const s = await summarizeChapter(ctx(), BOOK, 2, 'Chapter II');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const [i, c] of calls.entries()) {
      const user = String(c.messages[0]!.content);
      const passage = /<passage>\n([\s\S]*)\n<\/passage>/.exec(user)![1]!;
      expect(wordCount(passage)).toBeLessThanOrEqual(1000);
      expect(user).toContain('<earlier_chapters>第1章：温迪（Wendy）一家出场。</earlier_chapters>');
      expect(user).toContain(`<summary_so_far>${i === 0 ? '' : `摘要第${i}版`}</summary_so_far>`);
      expect(c.model).toBe('claude-haiku-5-5');
      expect(c.output_config?.format).toBeTruthy();
    }
    expect(s?.textZh).toBe(`摘要第${calls.length}版`);
    expect(await d.summaries.get([BOOK, 2])).toMatchObject({ textZh: `摘要第${calls.length}版`, model: 'claude-haiku-5-5' });
    const ledger = await d.ledger.toArray();
    expect(ledger.length).toBe(calls.length);
    expect(ledger.every((l) => l.purpose === 'summary' && l.bookId === BOOK)).toBe(true);
  });

  it('超过 300 字截断；和原文 8 词重合换成"（原文略）"并记守卫', async () => {
    d = new ReaderDB('t-sum-2');
    await d.paras.bulkPut(rows(1, CH1));
    reply = () => ({ summary: `邻居 Mrs Pell was the sort of neighbour who noticed everything 很烦。${'长'.repeat(400)}` });
    const s = await summarizeChapter(ctx(), BOOK, 1);
    expect(s!.textZh.length).toBe(SUMMARY_MAX_CHARS);
    expect(s!.textZh.startsWith('邻居 （原文略） 很烦。')).toBe(true);
    const ev = await d.guardEvents.toArray();
    expect(ev).toMatchObject([{ purpose: 'summary', kind: 'overlap' }]);
  });

  it('Summarizer：同一章并发只生成一次，已有摘要 0 次调用', async () => {
    d = new ReaderDB('t-sum-3');
    await d.paras.bulkPut(rows(1, CH1));
    const z = new Summarizer(ctx());
    const [a, b] = await Promise.all([z.ensure(BOOK, 1), z.ensure(BOOK, 1)]);
    expect(a?.textZh).toBe(b?.textZh);
    expect(z.runs).toBe(1);
    expect(calls.length).toBe(1); // 4 段短章 = 1 组
    await z.ensure(BOOK, 1);
    expect(calls.length).toBe(1);
    expect(await z.doneChapters(d, BOOK)).toEqual(new Set([1]));
  });

  it('不存在的章 → null，不发请求', async () => {
    d = new ReaderDB('t-sum-4');
    expect(await summarizeChapter(ctx(), BOOK, 9)).toBeNull();
    expect(calls.length).toBe(0);
  });
});
