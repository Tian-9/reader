import { afterEach, describe, expect, it } from 'vitest';
import { ensureChapterChunks, planChunks } from '../src/annotate/chunker';
import { wordCount } from '../src/annotate/text';
import { ReaderDB } from '../src/db/db';
import { BOOK, filler, rows } from './fixtures/t3';

let d: ReaderDB;
afterEach(async () => {
  await d?.delete();
});

const make = (sizes: number[]) => sizes.map((n, i) => ({ id: `c01p${String(i + 1).padStart(4, '0')}`, text: filler(n, i) }));
const sizesOf = (paras: { id: string; text: string }[], groups: string[][]) => {
  const wc = new Map(paras.map((p) => [p.id, wordCount(p.text)]));
  return groups.map((g) => g.reduce((s, id) => s + wc.get(id)!, 0));
};

describe('planChunks', () => {
  it('均匀小段 → 每组 600–900 词，不切段、不漏段、保持顺序', () => {
    const paras = make(Array.from({ length: 60 }, (_, i) => 40 + ((i * 37) % 90)));
    const groups = planChunks(paras);
    expect(groups.flat()).toEqual(paras.map((p) => p.id));
    for (const s of sizesOf(paras, groups)) {
      expect(s).toBeGreaterThanOrEqual(600 - 130);
      expect(s).toBeLessThanOrEqual(1000);
    }
    expect(sizesOf(paras, groups).slice(0, -1).every((s) => s >= 600 && s <= 900)).toBe(true);
  });
  it('整章不到 600 词 → 一组', () => {
    expect(planChunks(make([100, 200, 150]))).toHaveLength(1);
  });
  it('超长单段自己一组', () => {
    const groups = planChunks(make([300, 1200, 300, 400]));
    expect(groups[1]).toEqual(['c01p0002']);
  });
  it('章尾小尾巴并进前一组', () => {
    const paras = make([400, 400, 100]);
    expect(planChunks(paras)).toEqual([['c01p0001', 'c01p0002', 'c01p0003']]);
  });
});

describe('ensureChapterChunks', () => {
  it('切一次存起来，第二次原样返回，chunkId = 首段编号', async () => {
    d = new ReaderDB('t-chunks');
    await d.paras.bulkPut(rows(2, Array.from({ length: 20 }, (_, i) => filler(90, i))));
    const a = await ensureChapterChunks(d, BOOK, 2, 'A2', 'claude-haiku-5-5');
    expect(a.length).toBeGreaterThan(1);
    expect(a[0]!.chunkId).toBe('c02p0001');
    expect(a.every((c) => c.chunkId === c.paraIds[0] && c.status === 'todo')).toBe(true);
    await d.chunks.update([BOOK, a[0]!.chunkId], { status: 'done' });
    const b = await ensureChapterChunks(d, BOOK, 2, 'A2', 'claude-haiku-5-5');
    expect(b.map((c) => c.chunkId)).toEqual(a.map((c) => c.chunkId));
    expect(b[0]!.status).toBe('done');
    expect(await ensureChapterChunks(d, BOOK, 3, 'A2', 'claude-haiku-5-5')).toEqual([]);
  });
});
