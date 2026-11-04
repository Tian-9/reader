import { describe, expect, it } from 'vitest';
import { REDACTED, overlapIndex, quoteTooLong, redactOverlap } from '../src/annotate/guard';
import { processItems } from '../src/annotate/pipeline';
import { CH1, item, rows } from './fixtures/t3';

const paras = rows(1, CH1);
const meta = { bookId: 'b', chunkId: 'c01p0001', model: 'claude-haiku-5-5', now: 1 };

describe('输出守卫：quote 超 5 词', () => {
  it('5 词放行，6 词拦下', () => {
    expect(quoteTooLong('noticed everything and approved of')).toBe(false);
    expect(quoteTooLong('who noticed everything and approved of')).toBe(true);
  });
  it('processItems 丢弃 6 词 quote 并记一笔 quote-too-long', () => {
    const r = processItems(
      [item({ quote: 'who noticed everything and approved of', lemma: 'notice' }), item({ quote: 'approved of', lemma: 'approve of' })],
      paras,
      meta,
    );
    expect(r.rows.map((a) => a.quote)).toEqual(['approved of']);
    expect(r.stats).toMatchObject({ items: 2, stored: 1, quoteTooLong: 1, anchorFail: 0 });
    expect(r.events).toEqual([{ bookId: 'b', purpose: 'annotate', kind: 'quote-too-long', paraId: 'c01p0001', field: 'quote' }]);
  });
});

describe('输出守卫：≥8 词连续重合', () => {
  const index = overlapIndex([CH1[3]!]);
  it('8 词重合 → 那一段换成（原文略），前后的中文保留', () => {
    const field = '原句是 Nobody in Larkspur Close had ever seen a fox，意思是没人见过。';
    const g = redactOverlap(field, index);
    expect(g.hit).toBe(true);
    expect(g.text).toBe(`原句是 ${REDACTED}，意思是没人见过。`);
  });
  it('7 词重合不拦', () => {
    const g = redactOverlap('就是 in Larkspur Close had ever seen a 这几个词', index);
    expect(g.hit).toBe(false);
  });
  it('弯撇号、大小写不影响判断', () => {
    const idx = overlapIndex(['He didn’t want the soup, he didn’t want the bread at all.']);
    expect(redactOverlap("HE DIDN'T WANT THE SOUP he didn't want the", idx).hit).toBe(true);
  });
  it('processItems 替换 note_zh 并计 overlapHits', () => {
    const r = processItems(
      [
        item({
          kind: 'fun',
          quote: 'wearing spectacles',
          level: '-',
          fun_type: '作者幽默',
          note_zh: '整句 nobody in Larkspur Close had ever seen a fox wearing spectacles 很好笑',
        }),
      ],
      paras.map((p, i) => (i === 3 ? { ...p, id: 'c01p0001' } : p)).slice(3),
      meta,
    );
    expect(r.stats.overlapHits).toBe(1);
    expect(r.rows[0]!.noteZh).toBe(`整句 ${REDACTED} 很好笑`);
    expect(r.events[0]).toMatchObject({ kind: 'overlap', field: 'note_zh' });
  });
});

describe('processItems 其余分支', () => {
  it('段落编号不在本组、找不到 → anchorFail；重复条目去重；fun 的 lemma 清空', () => {
    const r = processItems(
      [
        item({ p: 'c09p0001', quote: 'nothing' }),
        item({ quote: 'disapproved' }),
        item({ p: 'c01p0002', quote: 'sideways', lemma: 'sideways' }),
        item({ p: 'c01p0002', quote: 'sideways', lemma: 'sideways' }),
        item({ kind: 'fun', p: 'c01p0002', quote: 'Lovely weather', lemma: 'x', level: '-' }),
      ],
      paras,
      meta,
    );
    expect(r.stats).toMatchObject({ items: 5, stored: 2, anchorFail: 2 });
    expect(r.rows.find((a) => a.kind === 'fun')!.lemma).toBe('');
  });
});
