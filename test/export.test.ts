import { afterEach, describe, expect, it } from 'vitest';
import { ReaderDB } from '../src/db/db';
import { buildBackup, importBackup, parseBackup } from '../src/export/backup';
import { buildVocabExport, lessonPrefix } from '../src/export/vocab';
import { recordUsage, totalUsd } from '../src/llm/ledger';
import { formatUsd, modelShort, spendFor, summarizeSpend } from '../src/llm/spend';
import { DEFAULT_SETTINGS } from '../src/settings.svelte';
import type { Annotation, Purpose, Word } from '../src/types';
import { longestEnglishRun, validateBackup, validateExport, validateVocab } from '../scripts/validate-export.mjs';

const dbs: ReaderDB[] = [];
const open = (name: string) => {
  const d = new ReaderDB(name);
  dbs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.delete();
});

const BOOK = 'book-pp';
const PARA_TEXT = 'All children, except one, grow up. They soon know that they will grow up.';

function word(lemma: string, status: Word['status'], paraId: string, glossZh = ''): Word {
  return { lemma, status, source: 'tapped', glossZh, firstSeen: { bookId: BOOK, paraId }, taps: 1, updatedAt: 1 };
}
function ann(lemma: string, paraId: string, glossZh: string, noteZh = '', quote = lemma): Annotation {
  return {
    id: `${paraId}-${lemma}`, bookId: BOOK, chunkId: 'c03p0001', paraId, kind: 'vocab', quote, start: 0, end: quote.length,
    lemma, level: 'C1', invented: false, funType: '-', glossZh, noteZh, model: 'claude-haiku-5-5', createdAt: 1,
  };
}

async function seed(d: ReaderDB) {
  await d.books.put({ id: BOOK, title: 'Peter Pan', author: 'J. M. Barrie', addedAt: 1 });
  await d.paras.put({ bookId: BOOK, id: 'c03p0002', chapter: 3, idx: 2, text: PARA_TEXT });
  await d.words.bulkPut([
    word('rummage', 'learning', 'c03p0002', '翻找'),
    word('sideways', 'unknown', 'c05p0010'), // 释义只在标注里
    word('grow up', 'unknown', 'c03p0002'), // 有释义 + 标注的 note
    word('mystery', 'unknown', 'c07p0001'), // 哪儿都没释义 → 跳过
    word('child', 'known', 'c01p0001', '孩子'), // known 不导
  ]);
  await d.annotations.bulkPut([
    ann('Sideways', 'c05p0010', '横着、斜着'),
    ann('grow up', 'c03p0002', '长大', '这里是"人人都要长大"的意思', 'grow up'),
  ]);
}

describe('生词导出', () => {
  it('lesson 前缀：书名驼峰、去冠词、只留 ASCII', () => {
    expect(lessonPrefix('Peter Pan')).toBe('PeterPan');
    expect(lessonPrefix('The Wonderful Wizard of Oz')).toBe('WonderfulWizardOfOz');
    expect(lessonPrefix("Harry Potter and the Philosopher's Stone")).toBe('HarryPotterAndThePhiloso');
    expect(lessonPrefix('彼得潘')).toBe('Book');
  });

  it('只导 learning/unknown；形状对、不带英文原句、过校验脚本', async () => {
    const d = open('t-exp-1');
    await seed(d);
    const { rows, skipped } = await buildVocabExport(d);
    expect(skipped).toEqual(['mystery']);
    expect(rows.map((r) => r.en)).toEqual(['grow up', 'rummage', 'sideways']);
    expect(rows[0]).toEqual({
      en: 'grow up', zh: '长大', lesson: 'PeterPan-ch03', cluster: '', key: '',
      gloss_zh: '这里是"人人都要长大"的意思', context_zh: '第 3 章', root: '', mishearing: '', mnemonic: '',
    });
    expect(rows[2]).toMatchObject({ en: 'sideways', zh: '横着、斜着', lesson: 'PeterPan-ch05', gloss_zh: '' });
    // 红线：段落原文一句都不在文件里
    const json = JSON.stringify(rows);
    expect(json).not.toContain('except one');
    expect(json).not.toContain('All children');
    expect(validateVocab(rows)).toEqual([]);
    expect(validateExport(rows)).toMatchObject({ kind: 'vocab', errors: [], count: 3 });
  });

  it('校验脚本会拦：缺 zh、多字段、en 超 5 词、lesson 格式、中文字段夹 6 个连续英文词、重复', () => {
    const ok = { en: 'rummage', zh: '翻找' };
    expect(validateVocab([ok])).toEqual([]);
    expect(validateVocab([{ en: 'x', zh: '' }])[0]).toMatch(/zh 必填/);
    expect(validateVocab([{ ...ok, quote: 'a b' }])[0]).toMatch(/多了字段 quote/);
    expect(validateVocab([{ ...ok, en: 'one two three four five six' }])[0]).toMatch(/超过 5 个词/);
    expect(validateVocab([{ ...ok, lesson: 'Peter Pan ch3' }])[0]).toMatch(/lesson/);
    expect(validateVocab([{ ...ok, context_zh: '她说 all children except one grow up 那句' }])[0]).toMatch(/6 个连续英文词/);
    expect(validateVocab([{ ...ok, context_zh: '原文 five words are fine here 就行' }])).toEqual([]);
    expect(validateVocab([ok, { ...ok }])[0]).toMatch(/重复/);
    expect(validateVocab({})).toEqual(['顶层必须是数组']);
    expect(longestEnglishRun('All children, except one, grow up.')).toBe(6);
  });
});

describe('词库备份', () => {
  it('备份过校验、不带 API key（也不带遗留口令）；清空数据后导入，词库条数一致、设置恢复', async () => {
    const d = open('t-bak-1');
    await seed(d);
    await d.settings.put({ key: 'app', ...DEFAULT_SETTINGS, apiKey: 'test-key-secret', appToken: 'old-token', level: 'B2', noSpoilers: true, readSize: 24 });
    const b = await buildBackup(d);
    expect(validateBackup(b)).toEqual([]);
    expect(JSON.stringify(b)).not.toContain('test-key-secret');
    expect(JSON.stringify(b)).not.toContain('old-token');
    const before = await d.words.count();
    const text = JSON.stringify(b);

    // 模拟"清空站点数据"：整个库删掉，重新开一个空库
    await d.delete();
    const fresh = open('t-bak-1');
    expect(await fresh.words.count()).toBe(0);
    const r = await importBackup(fresh, parseBackup(text), 'test-key-new');
    expect(r).toEqual({ imported: before, replaced: 0, total: before });
    expect(await fresh.words.count()).toBe(before);
    expect(await fresh.words.get('rummage')).toEqual(b.words.find((w) => w.lemma === 'rummage'));
    const s = await fresh.settings.get('app');
    expect(s).toMatchObject({ level: 'B2', noSpoilers: true, readSize: 24, apiKey: 'test-key-new' });
    expect(s?.appToken).toBeUndefined();
  });

  it('按 lemma 合并：同 lemma 用备份覆盖，本机多出来的保留，API key 保留本机的（备份里夹带的 key 不覆盖）', async () => {
    const d = open('t-bak-2');
    await d.words.bulkPut([word('rummage', 'known', 'c01p0001', '旧释义'), word('local-only', 'unknown', 'c01p0001', '本机')]);
    await d.settings.put({ key: 'app', ...DEFAULT_SETTINGS, apiKey: 'test-key-mine' });
    const b = parseBackup(
      JSON.stringify({
        format: 'reader-backup', version: 1, exportedAt: 1,
        words: [word('Rummage', 'learning', 'c03p0002', '翻找'), word('new-word', 'unknown', 'c02p0001', '新')],
        settings: { level: 'C1', noSpoilers: false, models: {}, apiKey: 'test-key-smuggled' },
      }),
    );
    const r = await importBackup(d, b);
    expect(r).toEqual({ imported: 2, replaced: 1, total: 3 });
    expect(await d.words.get('rummage')).toMatchObject({ status: 'learning', glossZh: '翻找' });
    expect(await d.words.get('local-only')).toBeTruthy();
    expect(await d.settings.get('app')).toMatchObject({ level: 'C1', apiKey: 'test-key-mine' });
  });

  it('坏文件一行不写：生词导出文件、非 JSON、版本不对、状态不对', async () => {
    expect(() => parseBackup('[{"en":"a","zh":"b"}]')).toThrow(/导出生词/);
    expect(() => parseBackup('not json')).toThrow(/不是 JSON/);
    expect(() => parseBackup('{"format":"reader-backup","version":2,"words":[]}')).toThrow(/版本/);
    expect(() => parseBackup('{"format":"reader-backup","version":1,"words":[{"lemma":"a","status":"meh"}]}')).toThrow(/状态/);
    expect(validateBackup({ format: 'reader-backup', version: 1, exportedAt: 1, words: [], settings: { appToken: 'x' } })[0]).toMatch(/appToken/);
    expect(validateBackup({ format: 'reader-backup', version: 1, exportedAt: 1, words: [], settings: { apiKey: 'x' } })[0]).toMatch(/apiKey/);
  });
});

describe('花费面板', () => {
  const PURPOSES: Purpose[] = ['annotate', 'tap', 'summary', 'chat'];
  const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

  it('面板数字 = 账本逐行相加，误差 < $0.001（含显示的 3 位小数）', async () => {
    const d = open('t-spend-1');
    // 固定种子的伪随机，300 笔，两本书 + 没挂书的
    let x = 42;
    const rnd = (n: number) => ((x = (x * 1103515245 + 12345) % 2 ** 31), x % n);
    for (let i = 0; i < 300; i++) {
      await recordUsage(d, {
        purpose: PURPOSES[rnd(4)]!,
        model: MODELS[rnd(3)]!,
        bookId: [BOOK, 'other', undefined][rnd(3)],
        usage: { input_tokens: rnd(5000), output_tokens: rnd(3000), cache_read_input_tokens: rnd(8000), cache_creation_input_tokens: rnd(2000) },
      });
    }
    const rows = await d.ledger.where('bookId').equals(BOOK).toArray();
    const ledgerSum = rows.reduce((s, r) => s + r.usd, 0);
    const p = await spendFor(d, BOOK);
    expect(p.calls).toBe(rows.length);
    expect(Math.abs(p.usd - ledgerSum)).toBeLessThan(0.001);
    expect(Math.abs(Number(formatUsd(p.usd).slice(1)) - ledgerSum)).toBeLessThan(0.001);
    // 分组之和 = 合计；每组/每个模型也逐项对账
    expect(Math.abs(p.groups.reduce((s, g) => s + g.usd, 0) - ledgerSum)).toBeLessThan(1e-9);
    expect(Math.abs(p.byModel.reduce((s, m) => s + m.usd, 0) - ledgerSum)).toBeLessThan(1e-9);
    for (const g of p.groups) {
      for (const m of g.models) {
        const direct = rows.filter((r) => r.purpose === g.purpose && r.model === m.model).reduce((s, r) => s + r.usd, 0);
        expect(Math.abs(m.usd - direct)).toBeLessThan(1e-9);
        expect(Math.abs(Number(formatUsd(m.usd).replace(/[<$]/g, '')) - direct)).toBeLessThan(0.001);
      }
    }
    // 全部（含没挂书的）= totalUsd
    expect(Math.abs((await spendFor(d)).usd - (await totalUsd(d)))).toBeLessThan(1e-9);
  });

  it('分组顺序 标注/补注/摘要/聊天，组内按花费排；格式化', () => {
    const e = (purpose: Purpose, model: string, usd: number) => ({ ts: 1, purpose, model, input: 0, output: 0, cacheRead: 5, cacheWrite: 0, usd });
    const s = summarizeSpend([e('chat', 'claude-sonnet-5-5', 0.02), e('annotate', 'claude-haiku-5-5', 0.001), e('chat', 'claude-opus-5-5', 0.04), e('annotate', 'claude-sonnet-5-5', 0.01)]);
    expect(s.groups.map((g) => g.label)).toEqual(['标注', '聊天']);
    expect(s.groups[1]!.models.map((m) => m.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(s.groups[0]!.models[0]!.cacheRead).toBe(5);
    expect(formatUsd(0)).toBe('$0.000');
    expect(formatUsd(0.0001)).toBe('<$0.001');
    expect(formatUsd(1.23456)).toBe('$1.235');
    expect(modelShort('claude-sonnet-5-5')).toBe('Sonnet 5.5');
  });
});
