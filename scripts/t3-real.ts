/**
 * T3 真跑验收（本地，直连 Anthropic，需要 shell 里有 ANTHROPIC_API_KEY；脚本不打印 key）。
 *
 *   node scripts/vrun.mjs scripts/t3-real.ts                 # 真跑，结果进 shots/
 *   node scripts/vrun.mjs scripts/t3-real.ts --mock --out DIR  # 假跑（不花钱，验证脚本本身），结果进 DIR
 *   可选：--book books/peter-pan.epub  --budget 2  --sample 1,5,12
 *
 * 步骤（PLAN T3 验收）：
 *  1. 第 1 章全部分组用 Haiku 标 → 锚定成功率、quote 词数、账本花费
 *  2. 挑一个第 1 章标出来的生词点"这个我会" → 全书同 lemma 不再显示；之后的请求 <known> 里有它（打日志）
 *  3. 第 5、12 章各挑一组用 Haiku 标（第 1 章那组已经有了）
 *  4. 回看第 1 章：新开一个标注器把每一段都"读"一遍，数 API 调用次数（应为 0）
 *  5. 三组用 Sonnet 再跑一遍做对照（单独一个库，不覆盖 Haiku 的结果）
 *  6. 三组 Haiku（和 Sonnet）结果渲染成静态 HTML，390px 宽截图
 * 任何时候累计花费超过 --budget（默认 $2）就停。
 */
import 'fake-indexeddb/auto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { annotateChunk, type AnnotateCtx, type CreateFn } from '../src/annotate/pipeline';
import { knownFromUser } from '../src/annotate/profile';
import { Annotator } from '../src/annotate/queue';
import { englishWordCount } from '../src/annotate/text';
import { isVisible } from '../src/annotate/visible';
import { lemmaSets, markKnown, normLemma } from '../src/annotate/words';
import { ReaderDB } from '../src/db/db';
import { totalUsd } from '../src/llm/ledger';
import type { Annotation, ChunkRow, ParaRow, Settings } from '../src/types';
import { shoot } from './t3-shot.mjs';
import { extractChapters } from './t3-epub';

const BOOK_ID = 'peter-pan-local';

function arg(args: string[], name: string, dflt: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
}

class BudgetError extends Error {}

/** 假的模型：从 passage 里挑词造条目（含一条找不到、一条 6 词），用来验证脚本本身。 */
function mockCreate(): CreateFn {
  return async (p: MessageCreateParamsNonStreaming): Promise<Message> => {
    const user = String(p.messages[0]!.content);
    const lines = [...user.matchAll(/^\[(c\d+p\d+)\] (.*)$/gm)];
    const items: Record<string, unknown>[] = [];
    const base = { occ: 1, invented: false, fun_type: '-', gloss_zh: '', note_zh: '' };
    for (const [, pid, text] of lines.slice(0, 6)) {
      const long = (text!.match(/[A-Za-z]{9,}/g) ?? [])[0];
      if (long) items.push({ ...base, kind: 'vocab', p: pid, quote: long, lemma: long.toLowerCase(), level: 'C1', gloss_zh: '（假）某个意思' });
    }
    const [, p0, t0] = lines[0]!;
    const two = t0!.split(/\s+/).slice(1, 3).join(' ');
    items.push({ ...base, kind: 'fun', p: p0, quote: two, lemma: '', level: '-', fun_type: '作者幽默', note_zh: '（假）这里作者在逗你。' });
    items.push({ ...base, kind: 'vocab', p: p0, quote: 'zzz not here', lemma: 'zzz', level: 'C2' });
    items.push({ ...base, kind: 'vocab', p: p0, quote: t0!.split(/\s+/).slice(0, 6).join(' '), lemma: 'x', level: 'C2' });
    return {
      id: 'mock',
      type: 'message',
      role: 'assistant',
      model: p.model,
      content: [{ type: 'text', text: JSON.stringify({ items }), citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2000, output_tokens: 1200, cache_read_input_tokens: 2600, cache_creation_input_tokens: 0 },
    } as unknown as Message;
  };
}

async function realCreate(): Promise<CreateFn> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('shell 里没有 ANTHROPIC_API_KEY（待 key）');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ maxRetries: 3 });
  return (p) => client.messages.create(p);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 一组的静态页面：正文（生词虚线、fun 页边 ※）+ 下面列出全部小注。 */
function renderHtml(title: string, paras: ParaRow[], anns: Annotation[], level: Settings['level'], known: Set<string>, marked: Set<string>): string {
  const vis = anns.filter((a) => isVisible(a, level, known, marked));
  const hidden = anns.filter((a) => !vis.includes(a));
  const body = paras
    .map((p) => {
      const here = vis.filter((a) => a.paraId === p.id).sort((a, b) => a.start - b.start || b.end - a.end);
      // 生词画虚线、fun 起点放一个锚（页边 ※ 由页面脚本按行定位）；重叠的生词只画第一个
      const cuts: { at: number; html: string }[] = [];
      let lastEnd = -1;
      for (const a of here) {
        if (a.kind === 'vocab') {
          if (a.start < lastEnd) continue;
          cuts.push({ at: a.start, html: '<span class="v">' }, { at: a.end, html: '</span>' });
          lastEnd = a.end;
        }
      }
      for (const a of here) if (a.kind === 'fun') cuts.push({ at: a.start, html: '<span class="fq"></span>' });
      cuts.sort((x, y) => x.at - y.at || (x.html === '</span>' ? -1 : 1));
      let out = '';
      let pos = 0;
      for (const c of cuts) {
        out += esc(p.text.slice(pos, c.at)) + c.html;
        pos = c.at;
      }
      out += esc(p.text.slice(pos));
      return `<p class="p" data-para-id="${p.id}">${out}</p>`;
    })
    .join('\n');
  const vocabList = vis
    .filter((a) => a.kind === 'vocab')
    .map((a) => `<li><b>${esc(a.quote)}</b> <span class="lv">${esc(a.lemma)} · ${a.level}${a.invented ? ' · 自造' : ''}</span><br>${esc(a.glossZh)}${a.noteZh ? `<br><span class="nt">${esc(a.noteZh)}</span>` : ''}</li>`)
    .join('');
  const funList = vis
    .filter((a) => a.kind === 'fun')
    .map((a) => `<li><b>※ ${esc(a.quote)}</b> <span class="lv">${esc(a.funType)}</span><br>${esc(a.noteZh)}</li>`)
    .join('');
  const hiddenList = hidden.map((a) => `${esc(a.lemma || a.quote)}(${a.level})`).join('，');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f7f3ea;--fg:#2b2620;--muted:#8a8174;--line:#e2dccf;--accent:#b5562b;--card:#fffdf8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,'PingFang SC',sans-serif}
.bar{padding:10px 16px;border-bottom:1px solid var(--line);font-size:13px;color:var(--muted)}
.bar b{color:var(--fg);font-size:15px}
main{padding:16px;position:relative}
.p{font-family:'Iowan Old Style',Palatino,Georgia,serif;font-size:19px;line-height:1.7;margin:0 0 .9em;position:relative}
.v{text-decoration:underline dashed var(--accent);text-decoration-thickness:1.5px;text-underline-offset:.24em}
.mk{position:absolute;color:var(--accent);font-size:13px;line-height:1;font-family:system-ui}
section{margin:8px 16px 20px;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:14px;line-height:1.55}
section h3{margin:0 0 6px;font-size:14px}
section ul{margin:0;padding-left:18px}
section li{margin:0 0 8px}
.lv{color:var(--muted);font-size:12px}
.nt{color:var(--muted)}
.hid{color:var(--muted);font-size:12px}
</style></head><body>
<div class="bar"><b>${esc(title)}</b><br>读者 ${level}：虚线 = 生词（${vis.filter((a) => a.kind === 'vocab').length}），※ = 有意思（${vis.filter((a) => a.kind === 'fun').length}）</div>
<main>${body}</main>
<section><h3>生词</h3><ul>${vocabList || '<li>（无）</li>'}</ul></section>
<section><h3>有意思</h3><ul>${funList || '<li>（无）</li>'}</ul></section>
<section class="hid">按阈值隐藏（≤${level} 或已点"我会"）：${hiddenList || '无'}</section>
<script>
for (const q of document.querySelectorAll('.fq')) {
  const p = q.closest('.p'); const r = q.getBoundingClientRect(); const pr = p.getBoundingClientRect();
  const m = document.createElement('span'); m.className = 'mk'; m.textContent = '※';
  m.style.top = (r.top - pr.top + 6) + 'px'; m.style.left = (pr.width + 3) + 'px'; p.appendChild(m);
}
</script></body></html>`;
}

export async function main(args: string[]) {
  const mock = args.includes('--mock');
  const book = arg(args, '--book', 'books/peter-pan.epub');
  const budget = Number(arg(args, '--budget', '2'));
  const sample = arg(args, '--sample', '1,5,12').split(',').map(Number);
  const out = path.resolve(arg(args, '--out', mock ? '' : 'shots'));
  if (!out) throw new Error('--mock 要配 --out <目录>（假跑结果别进 shots/）');
  const dataDir = path.join(out, 't3-data');
  mkdirSync(dataDir, { recursive: true });

  const chapters = extractChapters(book, BOOK_ID);
  console.log(`抽到 ${chapters.length} 章；第 1 章 ${chapters[0]!.paras.length} 段`);
  const need = new Set([1, ...sample]);
  const dH = new ReaderDB('t3-haiku');
  const dS = new ReaderDB('t3-sonnet');
  for (const d of [dH, dS]) {
    await d.delete();
    await d.open();
    for (const c of chapters) if (need.has(c.n)) await d.paras.bulkPut(c.paras);
  }

  const inner = mock ? mockCreate() : await realCreate();
  let callCount = 0;
  const create: CreateFn = async (p) => {
    const spent = (await totalUsd(dH)) + (await totalUsd(dS));
    if (spent > budget) throw new BudgetError(`累计花费 $${spent.toFixed(4)} 超过预算 $${budget}，停`);
    callCount++;
    return inner(p);
  };
  const knownLog: { chunk: string; known: string[] }[] = [];
  const settings: Pick<Settings, 'level' | 'models'> = { level: 'B1', models: {} };
  const mkCtx = (d: ReaderDB): AnnotateCtx => ({
    d,
    create,
    settings: () => settings,
    log: (m, x) => {
      if (m.includes('请求')) knownLog.push({ chunk: m.split(' ').at(-1)!, known: (x as { known: string[] }).known });
      console.log(m, x ? JSON.stringify(x) : '');
    },
  });
  const report: Record<string, unknown> = { mock, book: path.basename(book), budget };
  try {
    await steps();
  } catch (e) {
    report.stopped = e instanceof BudgetError ? `预算：${e.message}` : String(e);
    console.error('中途停下：', report.stopped);
  }
  report.usd = { haiku: await totalUsd(dH), sonnetCompare: await totalUsd(dS) };
  report.calls = callCount;
  writeFileSync(path.join(dataDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('总花费', JSON.stringify(report.usd), '调用', callCount, '次；报告', path.join(dataDir, 'report.json'));

  async function steps() {

  // 1. 第 1 章全量 Haiku
  const aH = new Annotator(mkCtx(dH));
  const ch1Chunks = await aH.chunksFrom(BOOK_ID, chapters[0]!.paras[0]!.id, 999).then((cs) => cs.filter((c) => c.chunkId.startsWith('c01')));
  for (const c of ch1Chunks) await aH.ensure(c);
  const ch1Rows = await dH.chunks.where('bookId').equals(BOOK_ID).toArray();
  const st = ch1Rows.filter((c) => c.chunkId.startsWith('c01')).map((c) => c.stats!);
  const sum = (k: 'items' | 'stored' | 'anchorFail' | 'quoteTooLong' | 'occFallback' | 'overlapHits') => st.reduce((s, x) => s + x[k], 0);
  const items = sum('items');
  const anchored = items - sum('anchorFail') - sum('quoteTooLong');
  const ch1Anns = (await dH.annotations.toArray()).filter((a) => a.paraId.startsWith('c01'));
  const longQuotes = ch1Anns.filter((a) => englishWordCount(a.quote) > 5);
  report.ch1 = {
    chunks: ch1Chunks.length,
    words: chapters[0]!.paras.reduce((s, p) => s + p.text.split(/\s+/).length, 0),
    items,
    anchored,
    anchorRate: items ? anchored / items : 1,
    anchorFail: sum('anchorFail'),
    quoteTooLong: sum('quoteTooLong'),
    occFallback: sum('occFallback'),
    overlapHits: sum('overlapHits'),
    stored: ch1Anns.length,
    storedQuoteOver5: longQuotes.length,
    refusalRetried: st.filter((x) => x.refusalRetried).length,
    usd: await totalUsd(dH),
    ledger: await dH.ledger.toArray(),
  };
  console.log('第 1 章：', JSON.stringify({ ...(report.ch1 as object), ledger: undefined }));

  // 2. "这个我会"
  const pick = ch1Anns.find((a) => a.kind === 'vocab' && isVisible(a, settings.level, new Set(), new Set()));
  if (pick) {
    const all = async () => dH.annotations.toArray();
    const before = (await all()).filter((a) => normLemma(a.lemma) === normLemma(pick.lemma));
    await markKnown(dH, { lemma: pick.lemma, level: pick.level, glossZh: pick.glossZh, bookId: BOOK_ID, paraId: pick.paraId });
    const { known, marked } = lemmaSets(await dH.words.toArray());
    report.known = { lemma: normLemma(pick.lemma), annotationsWithLemma: before.length, visibleAfter: before.filter((a) => isVisible(a, settings.level, known, marked)).length };
  }

  // 3. 第 5、12 章各一组（Haiku）
  const sampleChunks = new Map<number, ChunkRow>();
  for (const n of sample) {
    const first = chapters[n - 1]!.paras[0]!.id;
    const [c] = await aH.chunksFrom(BOOK_ID, first, 1);
    sampleChunks.set(n, c!);
    await aH.ensure(c!);
  }
  if (pick) {
    const after = knownLog.filter((k) => !k.chunk.startsWith('c01'));
    (report.known as Record<string, unknown>).nextRequests = after.map((k) => ({ chunk: k.chunk, knownHasIt: k.known.includes(normLemma(pick.lemma)) }));
    const sets = lemmaSets(await dH.words.toArray());
    const same = (await dH.annotations.toArray()).filter((a) => normLemma(a.lemma) === normLemma(pick.lemma));
    Object.assign(report.known as object, {
      annotationsWithLemmaAfterSamples: same.length,
      visibleAfterSamples: same.filter((a) => isVisible(a, settings.level, sets.known, sets.marked)).length,
    });
  }

  // 4. 回看第 1 章：新标注器，每一段都 ensureAround，数调用
  const callsBefore = callCount;
  const revisit = new Annotator(mkCtx(dH));
  for (const p of chapters[0]!.paras) {
    // 只看第 1 章内部（最后两组的 k+1/k+2 会伸到第 2 章，那是新内容，不算回看）
    const [k] = await revisit.chunksFrom(BOOK_ID, p.id, 1);
    await revisit.ensure(k!);
  }
  report.revisitCalls = callCount - callsBefore;
  console.log('回看第 1 章 API 调用次数：', report.revisitCalls);

  // 5. Sonnet 对照（单独的库）
  const ctxS = mkCtx(dS);
  await dS.words.bulkPut(await dH.words.toArray()); // 两边词库一致（<known> 一样），对照才公平
  for (const [n, c] of sampleChunks) {
    await dS.chunks.put({ ...c, status: 'todo' });
    await annotateChunk(ctxS, { ...c, status: 'todo' }, { model: 'claude-sonnet-5-5' });
    console.log(`Sonnet 第 ${n} 章 ${c.chunkId} 完成`);
  }

  // 6. 渲染 + 截图
  const shots: Record<string, string> = {};
  const compare: Record<string, unknown> = {};
  for (const [n, c] of sampleChunks) {
    for (const [label, d, suffix] of [['Haiku 5.5', dH, ''], ['Sonnet 5.5', dS, '-sonnet']] as const) {
      const paras = (await d.paras.bulkGet(c.paraIds.map((id) => [BOOK_ID, id] as [string, string]))) as ParaRow[];
      const anns = await d.annotations.where('chunkId').equals(c.chunkId).toArray();
      const { known, marked } = lemmaSets(await d.words.toArray());
      const html = renderHtml(`彼得潘 第 ${n} 章 · 组 ${c.chunkId}（${label}）`, paras, anns, settings.level, known, marked);
      const htmlPath = path.join(dataDir, `t3-ch${n}${suffix}.html`);
      writeFileSync(htmlPath, html);
      const png = path.join(out, `t3-ch${n}${suffix}.png`);
      const r = await shoot(`file://${htmlPath}`, png, { width: 390, scale: 1 });
      shots[`ch${n}${suffix}`] = png;
      if (r.errors.length) console.warn('页面报错', r.errors);
      const st2 = (await d.chunks.get([BOOK_ID, c.chunkId]))?.stats;
      (compare[`ch${n}`] ??= {}) as Record<string, unknown>;
      (compare[`ch${n}`] as Record<string, unknown>)[label] = {
        stats: st2,
        fun: anns.filter((a) => a.kind === 'fun').map((a) => ({ quote: a.quote, type: a.funType, note: a.noteZh })),
        vocab: anns.filter((a) => a.kind === 'vocab').map((a) => ({ quote: a.quote, lemma: a.lemma, level: a.level, gloss: a.glossZh })),
      };
    }
  }
  report.shots = shots;
  report.compare = compare;
  report.knownLog = knownLog;
  report.ledgerSonnet = await dS.ledger.toArray();
  }
}
