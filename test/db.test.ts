import { afterEach, describe, expect, it } from 'vitest';
import { ReaderDB, chapterParas } from '../src/db/db';
import { paraId, parseParaId } from '../src/types';

let d: ReaderDB;
afterEach(async () => {
  await d?.delete();
});

describe('paraId', () => {
  it('格式 c03p0012，能反解', () => {
    expect(paraId(3, 12)).toBe('c03p0012');
    expect(parseParaId('c03p0012')).toEqual({ chapter: 3, idx: 12 });
    expect(paraId(120, 1)).toBe('c120p0001');
    expect(parseParaId('c120p0001')).toEqual({ chapter: 120, idx: 1 });
    expect(parseParaId('x01p0001')).toBeNull();
  });
});

describe('Dexie 表', () => {
  it('段落按 [bookId+chapter+idx] 顺序取，章与章、书与书互不串', async () => {
    d = new ReaderDB('t-paras');
    const rows = [
      { bookId: 'b1', chapter: 2, idx: 10, text: 'j' },
      { bookId: 'b1', chapter: 2, idx: 2, text: 'b' },
      { bookId: 'b1', chapter: 1, idx: 1, text: 'x' },
      { bookId: 'b2', chapter: 2, idx: 1, text: 'other book' },
    ].map((r) => ({ ...r, id: paraId(r.chapter, r.idx) }));
    await d.paras.bulkPut(rows);
    const ch2 = await chapterParas(d, 'b1', 2);
    expect(ch2.map((p) => p.idx)).toEqual([2, 10]);
    expect(await d.paras.get(['b1', 'c02p0010'])).toMatchObject({ text: 'j' });
  });

  it('其余表能写能读', async () => {
    d = new ReaderDB('t-all');
    await d.books.put({ id: 'sha', title: 'Peter Pan', author: 'Barrie', addedAt: 1 });
    await d.chapters.put({ bookId: 'sha', n: 1, title: 'Peter Breaks Through', paraIds: ['c01p0001'] });
    await d.chunks.put({ bookId: 'sha', chunkId: 'c01p0001', paraIds: ['c01p0001'], status: 'todo', model: 'claude-haiku-5-5', promptVersion: 1, levelFloor: 'A2' });
    await d.words.put({ lemma: 'rummage', status: 'unknown', source: 'tapped', glossZh: '翻找', firstSeen: { bookId: 'sha', paraId: 'c01p0001' }, taps: 1, updatedAt: 1 });
    await d.progress.put({ bookId: 'sha', paraId: 'c01p0001', updatedAt: 1 });
    await d.summaries.put({ bookId: 'sha', chapter: 1, textZh: '…', model: 'claude-haiku-5-5' });
    const id = await d.ledger.add({ ts: 1, bookId: 'sha', purpose: 'annotate', model: 'claude-haiku-5-5', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.000001 });
    await d.settings.put({ key: 'app', apiKey: '', level: 'B1', noSpoilers: false, models: {} });

    expect((await d.chapters.get(['sha', 1]))?.title).toBe('Peter Breaks Through');
    expect(await d.chunks.where('[bookId+status]').equals(['sha', 'todo']).count()).toBe(1);
    expect((await d.words.get('rummage'))?.glossZh).toBe('翻找');
    expect((await d.summaries.get(['sha', 1]))?.model).toBe('claude-haiku-5-5');
    expect(typeof id).toBe('number');
    expect((await d.settings.get('app'))?.level).toBe('B1');
  });
});
