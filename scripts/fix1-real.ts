/**
 * 首用反馈修复（2026-11-04）的真跑：彼得潘第 1 章全部分组用标注管线跑一遍（模型按 roles.ts 默认，不改），
 * 统计"旧过滤（只看模型给的 level）"和"新过滤（+ 常用词闸 + 专有名词闸）"各显示多少生词、被滤掉的是哪些。
 *
 *   ANTHROPIC_API_KEY=… node scripts/vrun.mjs scripts/fix1-real.ts            # 结果：shots/fix1-data/report.json
 *   可选：--book books/peter-pan.epub  --budget 0.3  --level B1
 * key 不打印；累计花费超 --budget（默认 $0.3）就停，写半截报告。
 */
import 'fake-indexeddb/auto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CreateFn } from '../src/annotate/pipeline';
import { Annotator } from '../src/annotate/queue';
import { commonRank, hiddenReason, isVisible } from '../src/annotate/visible';
import { LEVEL_INDEX } from '../src/annotate/words';
import { ReaderDB } from '../src/db/db';
import { totalUsd } from '../src/llm/ledger';
import type { Annotation, ReaderLevel, Settings } from '../src/types';
import { extractChapters } from './t3-epub';

const BOOK_ID = 'peter-pan-fix1';
const arg = (args: string[], name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};

/** 修之前的 isVisible（只看 known / marked / invented / level），用来对比 */
function oldVisible(a: Annotation, threshold: ReaderLevel): boolean {
  if (a.kind === 'fun') return true;
  if (a.invented || a.level === '-') return true;
  return (LEVEL_INDEX[a.level] ?? 99) > LEVEL_INDEX[threshold]!;
}

export async function main(args: string[]) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('shell 里没有 ANTHROPIC_API_KEY');
  const book = arg(args, '--book', 'books/peter-pan.epub');
  const budget = Number(arg(args, '--budget', '0.3'));
  const level = arg(args, '--level', 'B1') as ReaderLevel;
  const out = path.resolve('shots/fix1-data');
  mkdirSync(out, { recursive: true });

  const chapters = extractChapters(book, BOOK_ID);
  const ch1 = chapters[0]!;
  const d = new ReaderDB('fix1-real');
  await d.delete();
  await d.open();
  await d.paras.bulkPut(ch1.paras);
  for (const c of chapters.slice(1, 2)) await d.paras.bulkPut(c.paras); // chunksFrom 会看下一章，有就行

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ maxRetries: 3 });
  let calls = 0;
  const create: CreateFn = async (p) => {
    const spent = await totalUsd(d);
    if (spent > budget) throw new Error(`累计花费 $${spent.toFixed(4)} 超过预算 $${budget}，停`);
    calls++;
    return client.messages.create(p);
  };
  const settings: Pick<Settings, 'level' | 'models'> = { level, models: {} };
  const a = new Annotator({ d, create, settings: () => settings, log: (m) => console.log(m) });
  const report: Record<string, unknown> = { book: path.basename(book), level, budget };
  try {
    const chunks = (await a.chunksFrom(BOOK_ID, ch1.paras[0]!.id, 999)).filter((c) => c.chunkId.startsWith('c01'));
    for (const c of chunks) await a.ensure(c);
    report.chunks = chunks.length;
  } catch (e) {
    report.stopped = String(e);
    console.error('中途停下：', report.stopped);
  }

  const text = new Map(ch1.paras.map((p) => [p.id, p.text]));
  const anns = (await d.annotations.toArray()).filter((x) => x.paraId.startsWith('c01'));
  const vocab = anns.filter((x) => x.kind === 'vocab');
  const levels: Record<string, number> = {};
  for (const v of vocab) levels[v.level] = (levels[v.level] ?? 0) + 1;
  const none = new Set<string>();
  const before = vocab.filter((v) => oldVisible(v, level));
  const after = vocab.filter((v) => isVisible(v, level, none, none, { paraText: (id) => text.get(id) }));
  const filtered = before.filter((v) => !after.includes(v));
  const row = (v: Annotation) => ({
    quote: v.quote,
    lemma: v.lemma,
    level: v.level,
    invented: v.invented,
    reason: hiddenReason(v, level, text.get(v.paraId)),
    ngslRank: commonRank(v.lemma || v.quote),
    stored: v.hiddenReason ?? null,
    gloss: v.glossZh,
  });
  // 旧过滤下显示出来的里面：多少是常用词（不分档，整张 NGSL）、多少是大写开头
  const commonAny = before.filter((v) => commonRank(v.lemma || v.quote) !== null);
  const capital = before.filter((v) => /^\p{Lu}/u.test(v.quote));
  Object.assign(report, {
    stored: { all: anns.length, vocab: vocab.length, fun: anns.length - vocab.length },
    levelDistribution: levels,
    visibleVocab: { before: before.length, after: after.length, filtered: filtered.length },
    beforeStats: {
      inNgslAnyRank: commonAny.map((v) => `${v.lemma}(#${commonRank(v.lemma || v.quote)})`),
      capitalized: capital.map((v) => v.quote),
    },
    filteredTop20: filtered.slice(0, 20).map(row),
    keptVocab: after.map(row),
    hiddenByLevelOnly: vocab.filter((v) => !oldVisible(v, level)).map(row),
    usd: await totalUsd(d),
    calls,
    ledger: await d.ledger.toArray(),
  });
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, keptVocab: undefined, hiddenByLevelOnly: undefined, ledger: undefined }, null, 2));
}
