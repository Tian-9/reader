/**
 * 2026-11-04 首用反馈的修复：常用词闸、专有名词闸、<known>/<unknown> 样本排除常用词、
 * "标注中…/预取下一段"小牌子状态、本章生词表。夹具全是自编句子。（解析器不插省略号在 epub.test.ts）
 */
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { afterEach, describe, expect, it } from 'vitest';
import { NGSL, NGSL_SUPPLEMENT } from '../src/annotate/common-words';
import { processItems, type AnnotateCtx } from '../src/annotate/pipeline';
import { knownSample, unknownSample } from '../src/annotate/profile';
import { Annotator, pillState } from '../src/annotate/queue';
import { tapAnnotate } from '../src/annotate/tap';
import {
  chapterVocabList,
  commonRank,
  hiddenReason,
  isCommonWord,
  isSentenceStart,
  isVisible,
  looksProperNoun,
} from '../src/annotate/visible';
import { lemmaSets } from '../src/annotate/words';
import { ReaderDB } from '../src/db/db';
import { buildVocabExport } from '../src/export/vocab';
import type { Annotation, ChunkRow, Settings, Word } from '../src/types';
import { BOOK, fakeMessage, filler, item, rows } from './fixtures/t3';

let d: ReaderDB | undefined;
afterEach(async () => {
  await d?.delete();
  d = undefined;
});

const vocab = (o: Partial<Annotation>): Annotation => ({
  id: o.id ?? `${o.paraId ?? 'c01p0001'}|${o.start ?? 0}`,
  bookId: BOOK,
  chunkId: 'c01p0001',
  paraId: 'c01p0001',
  kind: 'vocab',
  quote: o.lemma ?? 'x',
  start: 0,
  end: 1,
  lemma: 'x',
  level: 'B2',
  invented: false,
  funType: '-',
  glossZh: '某意思',
  noteZh: '',
  model: 'm',
  createdAt: 0,
  ...o,
});
const word = (lemma: string, status: Word['status'], updatedAt = 0, level?: Word['level']): Word => ({
  lemma,
  status,
  source: status === 'known' ? 'dismissed' : status === 'learning' ? 'self-rated' : 'tapped',
  glossZh: '意思',
  firstSeen: { bookId: BOOK, paraId: 'c01p0001' },
  taps: 0,
  updatedAt,
  ...(level ? { level } : {}),
});
const none = new Set<string>();

describe('常用词表（NGSL）', () => {
  it('表的形状：2809 个 lemma，频率顺序，小写；补充表有星期月份数字；文件 < 50KB', async () => {
    const list = NGSL.split(' ');
    expect(list).toHaveLength(2809);
    expect(list.slice(0, 3)).toEqual(['the', 'be', 'and']);
    expect(list.every((w) => /^[a-z][a-z'-]*$/.test(w))).toBe(true);
    expect(new Set(list).size).toBe(list.length);
    expect(NGSL_SUPPLEMENT.split(' ')).toEqual(expect.arrayContaining(['monday', 'december', 'twelve', 'hundred']));
    const { statSync } = await import('node:fs');
    expect(statSync('src/annotate/common-words.ts').size).toBeLessThan(50 * 1024);
  });

  it('按水平切档：A1 前 500、A2 前 1000、B1 前 2000、B2 起整张表', () => {
    const list = NGSL.split(' ');
    const at = (rank: number) => list[rank - 1]!;
    expect(isCommonWord(at(400), 'A1')).toBe(true);
    expect(isCommonWord(at(800), 'A1')).toBe(false);
    expect(isCommonWord(at(800), 'A2')).toBe(true);
    expect(isCommonWord(at(1500), 'A2')).toBe(false);
    expect(isCommonWord(at(1500), 'B1')).toBe(true);
    expect(isCommonWord(at(2500), 'B1')).toBe(false);
    expect(isCommonWord(at(2500), 'B2')).toBe(true);
    expect(isCommonWord('tuesday', 'A1')).toBe(true); // 补充表：任何水平都算
  });

  it('country 是常用词（首用反馈），Potter / 生僻词不是', () => {
    expect(commonRank('country')).toBeLessThan(500);
    expect(isCommonWord('country', 'B1')).toBe(true);
    expect(isCommonWord('Country', 'B1')).toBe(true);
    expect(commonRank('potter')).toBeNull();
    expect(commonRank('henceforth')).toBeNull();
    expect(commonRank('conspicuous')).toBeNull();
  });

  it('英式拼写、词形变化、带 to 的动词都能查到；短语不查', () => {
    for (const w of ['colour', 'neighbour', 'favourite', 'centre', 'theatre', 'realise', 'organisation', 'grey', 'mum', 'programme', 'defence', 'travelled']) {
      expect(commonRank(w), w).not.toBeNull();
    }
    for (const w of ['countries', 'realised', 'stopped', 'running', 'happily', 'carefully', 'to remain', 'children', 'went', 'feet', 'behaviour']) {
      expect(commonRank(w), w).not.toBeNull();
    }
    expect(commonRank('approve of')).toBeNull();
    expect(commonRank('all over the country')).toBeNull();
  });
});

describe('专有名词闸', () => {
  // 自编句子，结构照首用反馈那段（冒号 + 引号里一个人名）
  const s1 = 'People all over the town were raising their cups and whispering: “To Tobias Fenwick — the lad who stayed!”';
  const s2 = 'He waved at his cousin Rupert. … He could not know that Mr. Fenwick and Mrs Pell were watching.';
  const at = (s: string, w: string) => s.indexOf(w);

  it('句首判断：段首、句号/省略号/问叹号/冒号后、开引号后算句首；称谓缩写后不算', () => {
    expect(isSentenceStart(s1, 0)).toBe(true);
    expect(isSentenceStart(s1, at(s1, 'To '))).toBe(true); // 冒号 + 开引号
    expect(isSentenceStart(s1, at(s1, 'Tobias'))).toBe(false);
    expect(isSentenceStart(s2, at(s2, 'He could'))).toBe(true); // “. … He”
    expect(isSentenceStart(s2, at(s2, 'Fenwick and'))).toBe(false); // Mr. 后面
    expect(isSentenceStart(s2, at(s2, 'Pell'))).toBe(false); // Mrs（英式不带点）后面
    expect(isSentenceStart('“Hello,” Rupert said.', 9)).toBe(false); // 闭引号前是逗号
    expect(isSentenceStart('It was over!” Rupert said.', 14)).toBe(true); // 闭引号前是叹号
  });

  it('句中大写的人名 → 藏；句首的大写词、I、带小写词的名词短语 → 不藏', () => {
    expect(looksProperNoun(s1, at(s1, 'Fenwick'), 'Fenwick')).toBe(true);
    expect(looksProperNoun(s1, at(s1, 'Tobias'), 'Tobias Fenwick')).toBe(true);
    expect(looksProperNoun(s2, at(s2, 'Rupert'), 'Rupert')).toBe(true);
    expect(looksProperNoun(s1, 0, 'People')).toBe(false);
    expect(looksProperNoun(s1, at(s1, 'To '), 'To')).toBe(false);
    expect(looksProperNoun('They ate Brussels sprouts.', 8, 'Brussels sprouts')).toBe(false);
    expect(looksProperNoun('Well, I daresay he knew.', 6, 'I daresay')).toBe(false);
    expect(looksProperNoun(s1, at(s1, 'raising'), 'raising')).toBe(false);
  });
});

describe('isVisible：两道硬闸 + 原有规则', () => {
  const text = 'People across the country cheered: “To Tobias Fenwick, the lad who stayed!” The crowd was jubilant.';
  const paraText = () => text;
  const opts = { paraText };
  const countryAnn = vocab({ lemma: 'country', quote: 'country', start: text.indexOf('country'), level: 'B2' });
  const fenwick = vocab({ lemma: 'fenwick', quote: 'Fenwick', start: text.indexOf('Fenwick'), level: 'C1' });
  const jubilant = vocab({ lemma: 'jubilant', quote: 'jubilant', start: text.indexOf('jubilant'), level: 'C1' });

  it('模型把常用词标成 B2：B1 读者照样不显示（不信模型的 level）', () => {
    expect(isVisible(countryAnn, 'B1', none, none, opts)).toBe(false);
    expect(hiddenReason(countryAnn, 'B1', text)).toBe('common');
  });

  it('句中大写的人名（invented=false）不显示；invented=true 的照显示', () => {
    expect(isVisible(fenwick, 'B1', none, none, opts)).toBe(false);
    expect(hiddenReason(fenwick, 'B1', text)).toBe('proper');
    expect(isVisible({ ...fenwick, invented: true }, 'B1', none, none, opts)).toBe(true);
  });

  it('真生词照常显示；fun 不受影响', () => {
    expect(isVisible(jubilant, 'B1', none, none, opts)).toBe(true);
    expect(isVisible({ ...countryAnn, kind: 'fun', lemma: '', level: '-' }, 'B1', none, none, opts)).toBe(true);
  });

  it('点过卡片记成 unknown 的常用词/人名照样藏；她自己加进生词本（learning）的才显示', () => {
    const { known, marked, learning } = lemmaSets([word('country', 'unknown'), word('fenwick', 'unknown')]);
    expect(isVisible(countryAnn, 'B1', known, marked, { paraText, learning })).toBe(false);
    expect(isVisible(fenwick, 'B1', known, marked, { paraText, learning })).toBe(false);
    const s2 = lemmaSets([word('country', 'learning')]);
    expect(isVisible(countryAnn, 'B1', s2.known, s2.marked, { paraText, learning: s2.learning })).toBe(true);
  });

  it('lemma 写成短语、但划线的只是一个常用词：按划线的词算', () => {
    expect(isVisible({ ...countryAnn, lemma: 'all over the country' }, 'B1', none, none, opts)).toBe(false);
    // 多词 quote 的短语照常显示
    expect(isVisible(vocab({ lemma: 'approve of', quote: 'approved of', level: 'B2' }), 'B1', none, none)).toBe(true);
  });

  it('level 是 "-" 的 vocab（schema 没有 A1，模型可能拿 "-" 充数）也先过闸', () => {
    expect(isVisible({ ...countryAnn, level: '-' }, 'B1', none, none, opts)).toBe(false);
  });

  it('没有段落原文（老数据）时专有名词闸用入库时记的 hiddenReason', () => {
    expect(isVisible({ ...fenwick, hiddenReason: 'proper' }, 'B1', none, none)).toBe(false);
    expect(isVisible(fenwick, 'B1', none, none)).toBe(true);
  });

  it('水平调高后更多常用词被藏（按当前水平现算，不看入库时的标记）', () => {
    const rank2500 = NGSL.split(' ')[2499]!;
    const a = vocab({ lemma: rank2500, quote: rank2500, level: 'C1' });
    expect(isVisible(a, 'B1', none, none)).toBe(true);
    expect(isVisible(a, 'B2', none, none)).toBe(false);
  });
});

describe('入库时打 hiddenReason', () => {
  it('processItems：常用词标 common、句中人名标 proper、真生词不标', () => {
    const text = 'People across the country cheered for Tobias Fenwick, who looked jubilant.';
    const r = processItems(
      [
        item({ quote: 'country', lemma: 'country', level: 'B2' }),
        item({ quote: 'Fenwick', lemma: 'Fenwick', level: 'C1' }),
        item({ quote: 'jubilant', lemma: 'jubilant', level: 'C1' }),
      ],
      [{ id: 'c01p0001', text }],
      { bookId: BOOK, chunkId: 'c01p0001', model: 'm', level: 'B1' },
    );
    const by = Object.fromEntries(r.rows.map((a) => [a.quote, a.hiddenReason]));
    expect(by).toEqual({ country: 'common', Fenwick: 'proper', jubilant: undefined });
  });
});

describe('<known>/<unknown> 样本排除常用词', () => {
  it('known 里的常用词不进样本（省 token），生僻词照进', () => {
    const ws = [word('country', 'known', 3, 'B2'), word('house', 'known', 2), word('jubilant', 'known', 1, 'C1')];
    expect(knownSample(ws, 'B1')).toEqual(['jubilant']);
  });
  it('unknown 里的常用词不进样本，除非是她自己加的生词本', () => {
    const ws = [word('country', 'unknown', 3), word('house', 'learning', 2), word('jubilant', 'unknown', 1)];
    expect(unknownSample(ws, 'B1')).toEqual(['house', 'jubilant']);
  });
});

describe('点词补注 / 导出：被闸住的不计入词库', () => {
  it('点了一个常用词：卡片有释义，标注存库带 hiddenReason，但词库不记', async () => {
    d = new ReaderDB('t-gates-tap');
    const para = rows(1, ['People across the country cheered.'])[0]!;
    await d.paras.put(para);
    const ctx: AnnotateCtx = {
      d,
      settings: () => ({ level: 'B1', models: {} }),
      create: async () => fakeMessage({ lemma: 'country', level: 'A2', gloss_zh: '国家', note_zh: '' }),
    };
    const start = para.text.indexOf('country');
    const ann = await tapAnnotate(ctx, BOOK, para, { paraId: para.id, start, end: start + 7, surface: 'country' });
    expect(ann.glossZh).toBe('国家');
    expect(ann.hiddenReason).toBe('common');
    expect(await d.words.count()).toBe(0);
  });

  it('导出生词：unknown 的常用词不导，learning 的照导', async () => {
    d = new ReaderDB('t-gates-export');
    await d.words.bulkPut([word('country', 'unknown'), word('house', 'learning'), word('jubilant', 'unknown')]);
    const { rows: out } = await buildVocabExport(d, 'B1');
    expect(out.map((r) => r.en).sort()).toEqual(['house', 'jubilant']);
  });
});

describe('"标注中…"小牌子', () => {
  const chunk = (ids: string[]): Pick<ChunkRow, 'paraIds'> => ({ paraIds: ids });

  it('pillState：屏幕上的段落没标好 → 标注中；只差下一组 → 预取下一段；都好了 → 不显示', () => {
    expect(pillState([], ['c01p0001'])).toBe('idle');
    expect(pillState([chunk(['c01p0001', 'c01p0002'])], ['c01p0002'])).toBe('current');
    expect(pillState([chunk(['c01p0009', 'c01p0010'])], ['c01p0007', 'c01p0008'])).toBe('prefetch');
    // 屏幕跨两组、后一组还没好：仍算"标注中"
    expect(pillState([chunk(['c01p0009'])], ['c01p0008', 'c01p0009'])).toBe('current');
  });

  it('ensureAround 的回报：先 [k, k+1] → k 好了只剩 k+1（预取）→ []', async () => {
    d = new ReaderDB('t-gates-pill');
    for (const ch of [1]) await d.paras.bulkPut(rows(ch, Array.from({ length: 30 }, (_, i) => filler(90, i))));
    const settings: Pick<Settings, 'level' | 'models'> = { level: 'B1', models: {} };
    const gates: (() => void)[] = [];
    const ctx: AnnotateCtx = {
      d,
      settings: () => settings,
      create: (p: MessageCreateParamsNonStreaming) =>
        new Promise((res) => {
          const first = /\[(c\d+p\d+)\] (\S+)/.exec(String(p.messages[0]!.content))!;
          gates.push(() => res(fakeMessage({ items: [item({ p: first[1], quote: first[2], lemma: 'x', level: 'C1' })] })));
        }),
    };
    const a = new Annotator(ctx);
    const reports: string[][] = [];
    const run = a.ensureAround(BOOK, 'c01p0001', (p) => reports.push(p.map((c) => c.chunkId)));
    const tick = () => new Promise((r) => setTimeout(r, 10));
    while (!gates.length) await tick();
    const [k, k1] = reports[0]!;
    expect(reports[0]).toHaveLength(2);
    expect(pillState((await a.chunksFrom(BOOK, 'c01p0001', 2)).filter((c) => reports[0]!.includes(c.chunkId)), ['c01p0001'])).toBe('current');
    gates.shift()!(); // k 标好
    while (gates.length < 1 || reports.length < 2) await tick();
    expect(reports[1]).toEqual([k1]);
    const k1Row = (await a.chunksFrom(BOOK, 'c01p0001', 2))[1]!;
    expect(pillState([k1Row], ['c01p0001', 'c01p0002'])).toBe('prefetch');
    while (gates.length) gates.shift()!();
    await tick();
    while (gates.length) gates.shift()!(); // k+2 后台那组
    await run;
    expect(reports.at(-1)).toEqual([]);
    expect(k).toBe('c01p0001');
  });
});

describe('本章生词表', () => {
  it('按段落顺序 + 段内位置，只留 vocab，同 lemma 留第一处', () => {
    const list = chapterVocabList([
      vocab({ id: 'b', paraId: 'c01p0010', start: 5, lemma: 'jubilant' }),
      vocab({ id: 'a', paraId: 'c01p0002', start: 40, lemma: 'sideways' }),
      vocab({ id: 'f', paraId: 'c01p0001', start: 0, kind: 'fun', lemma: '' }),
      vocab({ id: 'c', paraId: 'c01p0002', start: 3, lemma: 'grumble' }),
      vocab({ id: 'd', paraId: 'c01p0011', start: 0, lemma: 'Jubilant' }),
    ]);
    expect(list.map((a) => a.id)).toEqual(['c', 'a', 'b']);
  });
});
