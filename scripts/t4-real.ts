/**
 * T4 真跑验收（本地，直连 Anthropic，需要 shell 里有 ANTHROPIC_API_KEY；脚本不打印 key）。
 *
 *   node scripts/vrun.mjs scripts/t4-real.ts                    # 真跑，报告写 shots/t4-data/report.json
 *   node scripts/vrun.mjs scripts/t4-real.ts --mock --out DIR   # 假跑（不花钱：假模型 + 缓存模拟器），报告写 DIR/t4-data/
 *   可选：--book books/peter-pan.epub  --budget 0.5
 *
 * 步骤（PLAN T4 验收），读者停在《彼得潘》第 3 章：
 *  0. 第 1、2 章生成前情摘要（Haiku，按组滚动）——顺带验摘要管线
 *  1. 防剧透开：从卡片"问小克"问第 3 章的一个词 → 请求的 <recent_words> 第一位是它
 *  2. 同一会话第二轮问"胡克最后怎么样了" → cache_read_input_tokens > 0；回答不该剧透（关键词粗筛 + 人看原文）
 *  3. 切英文模式再问 → 回答是简单英文（按字母/汉字占比粗判），cache_read 仍 > 0（system + 历史前缀没失效）
 *  4. "把这段原文念给我" → 显示里没有 ≥8 词的原文（守卫拦了，或者它自己改成了中文转述）
 *  5. 防剧透关：新会话问"胡克最后怎么样了" → 正常聊（应该提到鳄鱼/结局）
 * 累计花费超过 --budget 就停（默认 $0.5；real-all.sh 里 T3 + T4 合计 ≤ $2）。
 */
import 'fake-indexeddb/auto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { OVERLAP_WORDS, REDACTED, overlapIndex, redactOverlap } from '../src/annotate/guard';
import type { AnnotateCtx, CreateFn } from '../src/annotate/pipeline';
import { askPrefill, canonical, type RecentWord, type TurnContext } from '../src/chat/context';
import { newSession, sendTurn, type ChatDeps, type StreamFn, type TurnInput } from '../src/chat/session';
import { summarizeChapter } from '../src/chat/summary';
import { ReaderDB } from '../src/db/db';
import { totalUsd } from '../src/llm/ledger';
import type { ChatRecord, Settings } from '../src/types';
import { extractChapters } from './t3-epub';

const BOOK_ID = 'peter-pan-local';
const AT_CHAPTER = 3;

function arg(args: string[], name: string, dflt: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
}

class BudgetError extends Error {}

// ───────────────────────── 假模型 + 缓存模拟器 ─────────────────────────

/**
 * 按 Anthropic 的规则模拟 prompt caching：每个 cache_control 断点处的前缀（system → messages 按块顺序，
 * 去掉 cache_control 本身）存一份；下一次请求命中"之前存过的最长前缀"就算 cache_read。
 * 这样假跑也能验"第二轮前缀是不是一字不差"——前缀里任何一个字节变了，这里就读不到。
 */
class CacheSim {
  private seen = new Set<string>();
  usage(p: BetaMessageStreamParams): { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } {
    const blocks: { key: string; bp: boolean; len: number }[] = [];
    const push = (x: unknown) => {
      const bp = !!(x as { cache_control?: unknown }).cache_control;
      const key = canonical(x);
      blocks.push({ key, bp, len: Math.ceil(key.length / 3) });
    };
    for (const s of p.system as unknown[]) push(s);
    for (const m of p.messages) {
      if (typeof m.content === 'string') push({ role: m.role, text: m.content });
      else for (const b of m.content ?? []) push({ role: m.role, ...(b as object) });
    }
    let prefix = `${p.model}|`;
    let tokens = 0;
    let read = 0;
    let lastBp = 0;
    const ends: { key: string; tokens: number }[] = [];
    for (const b of blocks) {
      prefix += b.key + '\u0000';
      tokens += b.len;
      if (b.bp) {
        ends.push({ key: prefix, tokens });
        lastBp = tokens;
      }
      if (this.seen.has(prefix)) read = tokens;
    }
    for (const e of ends) this.seen.add(e.key);
    const write = Math.max(0, lastBp - read);
    return { input_tokens: Math.max(0, tokens - read - write), cache_read_input_tokens: read, cache_creation_input_tokens: write };
  }
}

function mockStream(): StreamFn {
  const sim = new CacheSim();
  return async (p, onText) => {
    const last = [...p.messages].reverse().find((m) => m.role === 'user')!;
    const blocks = last.content as { text: string }[];
    const q = blocks.at(-1)!.text;
    const ctx = blocks.at(-2)!.text;
    const en = [...p.messages].reverse().find((m) => m.role === 'system')?.content === '从现在起用简单英文回答';
    const screen = /<screen>\n\[\S+\] (.*)/.exec(ctx)?.[1] ?? '';
    let text: string;
    if (/念给我/.test(q)) text = `好，原文是这样：${screen} 念完了。`;
    else if (/胡克/.test(q)) text = ctx.includes('防剧透：开') ? '你才读到第3章，胡克的事先不说，读到了再聊。(¬‿¬)' : '最后在船上的决斗里掉进海里，被那条吞了闹钟的鳄鱼吃掉了。(｀・ω・´)';
    else if (en) text = 'Nana is the dog (狗) who works as a nurse (保姆). Funny, right? (^_^)';
    else text = `「${/<recent_words>\n([^：\n]+)/.exec(ctx)?.[1] ?? '?'}」这里是假回复。(・ω・)`;
    onText(text);
    return {
      id: 'mock',
      type: 'message',
      role: 'assistant',
      model: p.model,
      content: [
        { type: 'thinking', thinking: '', signature: 'mock-sig' },
        { type: 'text', text, citations: null },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { ...sim.usage(p), output_tokens: 200 },
    } as unknown as BetaMessage;
  };
}

function mockCreate(): CreateFn {
  return async (p: MessageCreateParamsNonStreaming): Promise<Message> => {
    const user = String(p.messages[0]!.content);
    const ch = /<chapter>(.*)<\/chapter>/.exec(user)?.[1] ?? '';
    const so = /<summary_so_far>(.*)<\/summary_so_far>/.exec(user)?.[1] ?? '';
    const summary = `${so ? so + '；' : ''}（假）${ch} 又发生了一些事`.slice(0, 300);
    return {
      id: 'mock',
      type: 'message',
      role: 'assistant',
      model: p.model,
      content: [{ type: 'text', text: JSON.stringify({ summary }), citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1500, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Message;
  };
}

async function realClients(): Promise<{ create: CreateFn; stream: StreamFn }> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('shell 里没有 ANTHROPIC_API_KEY（待 key）');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ maxRetries: 3 });
  return {
    create: (p) => client.messages.create(p).then((m) => {
    if (m.stop_reason === 'max_tokens') {
      // 截断诊断：看是思考吃光了预算还是正文本身太长（不含 key）
      const blocks = m.content.map((b) => b.type === 'text' ? { type: 'text', chars: b.text.length, tail: b.text.slice(-200) } : b.type === 'thinking' ? { type: 'thinking', chars: b.thinking.length } : { type: b.type });
      console.log('[截断诊断]', JSON.stringify({ model: m.model, max_tokens: p.max_tokens, usage: m.usage, blocks }));
    }
    return m;
  }),
    stream: async (p, onText) => {
      const s = client.beta.messages.stream(p);
      s.on('text', (d) => onText(d));
      return s.finalMessage();
    },
  };
}

// ───────────────────────── 判定小工具 ─────────────────────────

const cjk = (s: string) => (s.match(/[一-鿿]/g) ?? []).length;
const latin = (s: string) => (s.match(/[A-Za-z]/g) ?? []).length;
/** 英文为主：拉丁字母比汉字多 3 倍以上（简单英文 + 难词括号带中文，汉字会有一些） */
const mostlyEnglish = (s: string) => latin(s) > 3 * cjk(s);
const SPOILER_WORDS = /鳄鱼|crocodile|被吃|吃掉|淹死|死了|决斗|最后.{0,6}(死|掉进)/i;

export async function main(args: string[]) {
  const mock = args.includes('--mock');
  const book = arg(args, '--book', 'books/peter-pan.epub');
  const budget = Number(arg(args, '--budget', '0.5'));
  const out = path.resolve(arg(args, '--out', mock ? '' : 'shots'));
  if (!out) throw new Error('--mock 要配 --out <目录>（假跑结果别进 shots/）');
  const dataDir = path.join(out, 't4-data');
  mkdirSync(dataDir, { recursive: true });

  const chapters = extractChapters(book, BOOK_ID).slice(0, AT_CHAPTER);
  const d = new ReaderDB('t4-run');
  await d.delete();
  await d.open();
  await d.books.put({ id: BOOK_ID, title: 'Peter Pan', author: 'J. M. Barrie', addedAt: Date.now() });
  for (const c of chapters) {
    await d.paras.bulkPut(c.paras);
    await d.chapters.put({ bookId: BOOK_ID, n: c.n, title: c.title, paraIds: c.paras.map((p) => p.id) });
  }

  const inner = mock ? { create: mockCreate(), stream: mockStream() } : await realClients();
  let calls = 0;
  const guardBudget = async () => {
    const spent = await totalUsd(d);
    if (spent > budget) throw new BudgetError(`累计花费 $${spent.toFixed(4)} 超过预算 $${budget}，停`);
    calls++;
  };
  const create: CreateFn = async (p) => (await guardBudget(), inner.create(p));
  const stream: StreamFn = async (p, onText) => (await guardBudget(), inner.stream(p, onText));

  const settings: Pick<Settings, 'level' | 'models' | 'noSpoilers'> = { level: 'B1', models: {}, noSpoilers: true };
  const log = (m: string, x?: unknown) => console.log(m, x ? JSON.stringify(x) : '');
  const actx: AnnotateCtx = { d, create, settings: () => settings, log };
  const deps: ChatDeps = { d, stream, settings: () => settings, log: (m) => void m };

  const report: Record<string, unknown> = { mock, book: path.basename(book), budget, atChapter: AT_CHAPTER };
  const checks: { name: string; pass: boolean | null; detail: unknown }[] = [];
  report.checks = checks;
  const turns: unknown[] = [];
  report.turns = turns;

  const ch3 = chapters[AT_CHAPTER - 1]!;
  const ch3Texts = ch3.paras.map((p) => p.text);
  // 屏幕：第 3 章中间一段较长的段落 + 后面一段
  const midIdx = ch3.paras.findIndex((p, i) => i > ch3.paras.length / 3 && p.text.split(/\s+/).length > 60);
  const screen = ch3.paras.slice(midIdx, midIdx + 2).map((p) => ({ id: p.id, text: p.text }));
  // "卡片上点问小克"的词：屏幕段落里第一个 ≥9 字母的词
  const askWord = (/\b[a-z]{9,}\b/.exec(screen[0]!.text)?.[0] ?? 'nursery').toLowerCase();

  const mkTurn = (recent: RecentWord[]): TurnContext => ({
    chapter: AT_CHAPTER,
    chapterTitle: ch3.title,
    noSpoilers: settings.noSpoilers,
    screen,
    recent,
  });
  const mkInput = (q: string, recent: RecentWord[] = []): TurnInput => ({
    question: q,
    book: { title: 'Peter Pan', author: 'J. M. Barrie' },
    turn: mkTurn(recent),
    guardSources: [...ch3Texts, ...screen.map((p) => p.text)],
  });
  const index = overlapIndex([...ch3Texts]);
  const run = async (label: string, s: ChatRecord, inp: TurnInput) => {
    const r = await sendTurn(deps, s, inp);
    if (!r.ok) throw new Error(`${label}：${r.error}`);
    const u = r.message.usage;
    const row = {
      label,
      question: inp.question,
      model: r.message.model,
      lang: s.lang,
      noSpoilers: inp.turn.noSpoilers,
      usage: { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens },
      usd: r.ledger.usd,
      guarded: r.guarded,
      reply: r.text,
    };
    turns.push(row);
    console.log(`\n[${label}] ${inp.question}\n→ ${r.text}\n  usage ${JSON.stringify(row.usage)} $${row.usd.toFixed(4)}`);
    return { r, row };
  };

  try {
    // 0. 前情摘要
    for (const n of [1, 2]) {
      const s = await summarizeChapter(actx, BOOK_ID, n, chapters[n - 1]!.title);
      console.log(`第${n}章摘要：${s?.textZh}`);
    }
    const sums = await d.summaries.toArray();
    report.summaries = sums;
    checks.push({ name: '摘要：第 1、2 章生成，≤300 字', pass: sums.length === 2 && sums.every((x) => x.textZh.length > 0 && x.textZh.length <= 300), detail: sums.map((x) => x.textZh.length) });

    // 1. 防剧透开：从卡片问小克
    settings.noSpoilers = true;
    const sA = newSession(BOOK_ID, AT_CHAPTER, 'claude-sonnet-5-5');
    const focus: RecentWord = { term: askWord, glossZh: '（卡片上的释义）', kind: 'vocab', asked: true };
    const t1 = await run('问小克（防剧透开）', sA, mkInput(askPrefill(focus), [focus]));
    const rw = /<recent_words>\n([^\n]+)/.exec(JSON.stringify(t1.r.request.messages.at(-1)).replace(/\\n/g, '\n'))?.[1] ?? '';
    checks.push({ name: '卡片问小克：<recent_words> 第一位是这个词', pass: rw.startsWith(askWord), detail: { askWord, firstLine: rw } });

    // 2. 第二轮：缓存 + 防剧透
    const t2 = await run('胡克最后怎么样（防剧透开）', sA, mkInput('胡克最后怎么样了？'));
    checks.push({ name: '同一会话第二轮 cache_read_input_tokens > 0', pass: (t2.row.usage.cacheRead ?? 0) > 0, detail: t2.row.usage });
    checks.push({ name: '防剧透开：不剧透（关键词粗筛，最终人看 reply）', pass: !SPOILER_WORDS.test(t2.r.text), detail: t2.r.text });

    // 3. 切英文
    sA.lang = 'en';
    const t3 = await run('英文模式', sA, mkInput('What does Nana do in this chapter?'));
    checks.push({ name: '英文模式：回答以英文为主', pass: mostlyEnglish(t3.r.text), detail: { latin: latin(t3.r.text), cjk: cjk(t3.r.text) } });
    checks.push({ name: '英文模式：缓存没失效（cache_read > 0）', pass: (t3.row.usage.cacheRead ?? 0) > 0, detail: t3.row.usage });
    checks.push({
      name: '英文模式：system 一字未改，切换是历史里追加的 role:"system"',
      pass: canonical(t3.r.request.system) === canonical(t1.r.request.system) && t3.r.request.messages.at(-1)?.role === 'system',
      detail: t3.r.request.messages.slice(-2).map((m) => m.role),
    });

    // 4. 念原文（切回中文问，更像她会怎么说）
    sA.lang = 'zh';
    const t4 = await run('念原文', sA, mkInput('把这段原文念给我'));
    const leftover = redactOverlap(t4.r.text, index);
    checks.push({
      name: `念原文：显示里没有 ≥${OVERLAP_WORDS} 词的原文（守卫拦下或模型自己转述）`,
      pass: !leftover.hit,
      detail: { guardHit: t4.r.guarded, hasRedactedMark: t4.r.text.includes(REDACTED), reply: t4.r.text },
    });

    // 5. 防剧透关：新会话
    settings.noSpoilers = false;
    const sB = newSession(BOOK_ID, AT_CHAPTER, 'claude-sonnet-5-5');
    const t5 = await run('胡克最后怎么样（防剧透关）', sB, mkInput('胡克最后怎么样了？'));
    checks.push({ name: '防剧透关：正常聊结局（关键词粗筛，最终人看 reply）', pass: SPOILER_WORDS.test(t5.r.text), detail: t5.r.text });
  } catch (e) {
    report.stopped = e instanceof BudgetError ? `预算：${e.message}` : String(e);
    console.error('中途停下：', report.stopped);
  }

  report.usd = await totalUsd(d);
  report.calls = calls;
  report.ledger = await d.ledger.toArray();
  report.guardEvents = await d.guardEvents.toArray();
  report.allPass = checks.length > 0 && checks.every((c) => c.pass) && !report.stopped;
  writeFileSync(path.join(dataDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n验收：');
  for (const c of checks) console.log(`  ${c.pass ? '过' : '不过'}  ${c.name}`);
  console.log(`总花费 $${(report.usd as number).toFixed(4)}，调用 ${calls} 次；报告 ${path.join(dataDir, 'report.json')}`);
  await d.delete();
}
