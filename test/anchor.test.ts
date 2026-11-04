import { describe, expect, it } from 'vitest';
import { resolveAnchor } from '../src/annotate/anchor';
import { englishWordCount } from '../src/annotate/text';
import { CH1 } from './fixtures/t3';

const slice = (text: string, r: ReturnType<typeof resolveAnchor>) => (r.ok ? text.slice(r.start, r.end) : null);

describe('锚定：弯/直引号', () => {
  const t = CH1[1]!; // “Lovely weather,” said Mr Quinn … ‘Lovely,’ agreed nobody.
  it('模型抄成直引号，原文是弯引号 → 映射回原文的弯引号位置', () => {
    const r = resolveAnchor(t, '"Lovely weather,"', 1);
    expect(r.ok).toBe(true);
    expect(slice(t, r)).toBe('“Lovely weather,”');
  });
  it('反过来：原文直引号，模型给弯引号', () => {
    const plain = `She said "it's fine" twice.`;
    expect(slice(plain, resolveAnchor(plain, '“it’s fine”', 1))).toBe('"it\'s fine"');
  });
  it('大小写、多余空格不敏感', () => {
    expect(slice(t, resolveAnchor(t, 'RAIN   came  down', 1))).toBe('rain came down');
  });
  it('首尾标点对不上时去掉再找', () => {
    expect(slice(t, resolveAnchor(t, 'sideways!', 1))).toBe('sideways');
  });
});

describe('锚定：occ 重复出现', () => {
  const t = CH1[2]!; // the kettle ×3
  it('第 2、3 次出现落在不同位置', () => {
    const r1 = resolveAnchor(t, 'the kettle', 1);
    const r2 = resolveAnchor(t, 'the kettle', 2);
    const r3 = resolveAnchor(t, 'the kettle', 3);
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    if (r1.ok && r2.ok && r3.ok) {
      expect(r1.start).toBe(0);
      expect(r2.start).toBe(t.indexOf('the kettle', 1));
      expect(r3.start).toBe(t.lastIndexOf('the kettle'));
      expect(t.slice(r2.start, r2.end)).toBe('the kettle');
    }
  });
  it('只认词边界："start" 里的 "art" 不算', () => {
    const r = resolveAnchor(CH1[3]!, 'art', 1);
    expect(r).toEqual({ ok: false, reason: 'not-found' });
  });
  it('occ 超出实际次数 → 退回第一次，标 occFallback', () => {
    const r = resolveAnchor(t, 'reluctant whistle', 4);
    expect(r.ok && r.occFallback).toBe(true);
    expect(slice(t, r)).toBe('reluctant whistle');
  });
});

describe('锚定：找不到 / 太长', () => {
  it('段落里没有的词 → not-found', () => {
    expect(resolveAnchor(CH1[0]!, 'approved of everything', 1)).toEqual({ ok: false, reason: 'not-found' });
  });
  it('6 个词的 quote → too-long（即使原文里有）', () => {
    expect(resolveAnchor(CH1[0]!, 'who noticed everything and approved of', 1)).toEqual({ ok: false, reason: 'too-long' });
  });
  it('空 quote → empty', () => {
    expect(resolveAnchor(CH1[0]!, '  ', 1)).toEqual({ ok: false, reason: 'empty' });
  });
  it('词数：破折号算断开，撇号不算', () => {
    expect(englishWordCount('once more than strictly necessary')).toBe(5);
    expect(englishWordCount('well—you see')).toBe(3);
    expect(englishWordCount("Mrs Pell's step")).toBe(3);
  });
});
