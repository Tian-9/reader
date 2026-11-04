import type { BetaMessage, BetaMessageParam, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACTED } from '../src/annotate/guard';
import {
  canonical,
  countBreakpoints,
  pickScreen,
  turnContextText,
  withTailBreakpoint,
  type TurnContext,
} from '../src/chat/context';
import { effectiveLang, gatherRecent, newSession, resumeOrNew, sendTurn, type ChatDeps, type TurnInput } from '../src/chat/session';
import { ReaderDB } from '../src/db/db';
import { CHAT_EN_MODE, CHAT_SYSTEM, CHAT_ZH_MODE } from '../src/llm/prompts/chat';
import type { ChatRecord, Settings } from '../src/types';
import { BOOK, CH1 } from './fixtures/t3';

/** 假的流式回复：一个 thinking 块（带签名）+ 一个文本块，文本分两截"流"出来。 */
function fakeBeta(text: string, o: { model?: string; stop?: BetaMessage['stop_reason']; cacheRead?: number } = {}): BetaMessage {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: o.model ?? 'claude-sonnet-5-5',
    content:
      o.stop === 'refusal'
        ? []
        : [
            { type: 'thinking', thinking: '', signature: 'sig-abc' },
            { type: 'text', text, citations: null },
          ],
    stop_reason: o.stop ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: o.cacheRead ?? 0, cache_creation_input_tokens: 900 },
  } as unknown as BetaMessage;
}

let d: ReaderDB;
let sent: BetaMessageStreamParams[];
let replies: (() => BetaMessage | Error)[];
let settings: Pick<Settings, 'models' | 'noSpoilers'>;

const deps = (): ChatDeps => ({
  d,
  settings: () => settings,
  stream: async (params, onText) => {
    sent.push(structuredClone(params));
    const r = (replies.shift() ?? (() => fakeBeta('好的 (｡•̀ᴗ-)✧')))();
    if (r instanceof Error) throw r;
    const t = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    onText(t.slice(0, 3));
    onText(t.slice(3));
    return r;
  },
});

const turn = (o: Partial<TurnContext> = {}): TurnContext => ({
  chapter: 3,
  chapterTitle: 'Chapter III. COME AWAY, COME AWAY!',
  noSpoilers: true,
  screen: [{ id: 'c03p0002', text: CH1[1]! }],
  recent: [{ term: 'sideways', glossZh: '横着', kind: 'vocab', asked: true }],
  ...o,
});
const input = (question: string, o: Partial<TurnContext> = {}): TurnInput => ({
  question,
  book: { title: 'Peter Pan', author: 'J. M. Barrie' },
  turn: turn(o),
  guardSources: CH1,
});

beforeEach(async () => {
  sent = [];
  replies = [];
  settings = { models: {}, noSpoilers: true };
});
afterEach(async () => {
  await d?.delete();
});

describe('上下文组装（PLAN 2.9）', () => {
  it('第一轮：system=小克（断点1）→ 首条 user：前情（断点2）+ 屏幕/最近的词 + 问题（断点3）', async () => {
    d = new ReaderDB('t-chat-1');
    await d.summaries.put({ bookId: BOOK, chapter: 1, textZh: '达林家三个孩子。', model: 'x' });
    await d.summaries.put({ bookId: BOOK, chapter: 3, textZh: '本章的不该出现', model: 'x' });
    const s = newSession(BOOK, 3, 'claude-sonnet-5-5');
    const r = await sendTurn(deps(), s, input('sideways 什么意思'));
    expect(r.ok).toBe(true);
    const p = sent[0]!;
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(p).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', thinking: { type: 'adaptive' } });
    // 断点 1：system 只有人格，没有任何易变内容
    expect(p.system).toEqual([{ type: 'text', text: CHAT_SYSTEM, cache_control: { type: 'ephemeral' } }]);
    const m0 = p.messages[0] as { role: string; content: { text: string; cache_control?: unknown }[] };
    expect(m0.role).toBe('user');
    expect(m0.content).toHaveLength(3);
    // 断点 2：前情（只含本章之前的摘要）
    expect(m0.content[0]!.text).toContain('<story_so_far>\n第1章：达林家三个孩子。\n</story_so_far>');
    expect(m0.content[0]!.text).not.toContain('本章的不该出现');
    expect(m0.content[0]!.cache_control).toEqual({ type: 'ephemeral' });
    // 本轮：屏幕 + 最近的词 + 防剧透
    expect(m0.content[1]!.text).toContain('<screen>\n[c03p0002] “Lovely weather,”');
    expect(m0.content[1]!.text).toMatch(/<recent_words>\nsideways：横着（她刚点了"问小克"问的就是这个）/);
    expect(m0.content[1]!.text).toContain('防剧透：开');
    expect(m0.content[1]!.cache_control).toBeUndefined();
    // 断点 3：最后一条 user 的最后一块
    expect(m0.content[2]).toEqual({ type: 'text', text: 'sideways 什么意思', cache_control: { type: 'ephemeral' } });
    expect(countBreakpoints(p.system as unknown[], p.messages)).toBe(3);
  });

  it('第二轮：请求前缀 = 第一轮请求 + 助手回复（逐字节一样，只是断点挪位）→ 能命中缓存', async () => {
    d = new ReaderDB('t-chat-2');
    const s = newSession(BOOK, 3, 'claude-sonnet-5-5');
    await sendTurn(deps(), s, input('第一句'));
    await sendTurn(deps(), s, input('第二句', { screen: [{ id: 'c03p0003', text: CH1[2]! }] }));
    const [a, b] = sent as [BetaMessageStreamParams, BetaMessageStreamParams];
    expect(canonical(b.system)).toBe(canonical(a.system));
    expect(canonical(b.messages.slice(0, a.messages.length))).toBe(canonical(a.messages));
    // 助手回复原样回传：thinking 块和签名都在
    expect(b.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-abc' }, { type: 'text', text: '好的 (｡•̀ᴗ-)✧', citations: null }] });
    // 新屏幕只在新的 user 消息里
    expect(JSON.stringify(b.messages[2])).toContain('c03p0003');
    expect(JSON.stringify(b.messages.slice(0, 2))).not.toContain('c03p0003');
    expect(countBreakpoints(b.system as unknown[], b.messages)).toBe(3);
    // 存库的历史不带断点 3（只有前情块的断点 2）
    const saved = await d.chats.get(s.id);
    expect(countBreakpoints([], saved!.messages)).toBe(1);
    expect(saved!.display!.map((l) => l.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('切英文：不改 system，在本轮 user 后追加 role:"system"；之前的前缀不变；切回中文同理', async () => {
    d = new ReaderDB('t-chat-3');
    const s = newSession(BOOK, 3, 'claude-sonnet-5-5');
    await sendTurn(deps(), s, input('中文问'));
    s.lang = 'en';
    await sendTurn(deps(), s, input('now english'));
    const [a, b] = sent as [BetaMessageStreamParams, BetaMessageStreamParams];
    expect(canonical(b.system)).toBe(canonical(a.system));
    expect(canonical(b.messages.slice(0, a.messages.length))).toBe(canonical(a.messages));
    expect(b.messages.slice(-2).map((m) => m.role)).toEqual(['user', 'system']);
    expect(b.messages.at(-1)).toEqual({ role: 'system', content: CHAT_EN_MODE });
    // 断点 3 在 user 上，不在 system 消息上
    expect(JSON.stringify(b.messages.at(-1))).not.toContain('cache_control');
    expect(JSON.stringify(b.messages.at(-2))).toContain('cache_control');
    expect(effectiveLang(s.messages)).toBe('en');
    // 英文模式下再问一句：不重复追加
    await sendTurn(deps(), s, input('again'));
    expect(sent[2]!.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    s.lang = 'zh';
    await sendTurn(deps(), s, input('切回来'));
    expect(sent[3]!.messages.at(-1)).toEqual({ role: 'system', content: CHAT_ZH_MODE });
    expect(s.display!.filter((l) => l.role === 'note').map((l) => l.text)).toEqual(['已切到英文模式', '已切回中文']);
  });

  it('防剧透关：上下文里写"关"', () => {
    expect(turnContextText(turn({ noSpoilers: false }))).toContain('防剧透：关（可以聊全书）');
  });

  it('屏幕段落按词数截，问的词所在段一定带上', () => {
    const paras = Array.from({ length: 10 }, (_, i) => ({ id: `c01p000${i}`, text: Array(100).fill('w').join(' ') }));
    const picked = pickScreen(paras, 'c01p0009', 300);
    expect(picked.map((p) => p.id)).toEqual(['c01p0000', 'c01p0001', 'c01p0009']);
  });

  it('withTailBreakpoint 不改原历史', () => {
    const h: BetaMessageParam[] = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
    const out = withTailBreakpoint(h);
    expect(JSON.stringify(out)).toContain('cache_control');
    expect(JSON.stringify(h)).not.toContain('cache_control');
  });
});

describe('输出守卫 + 出错处理', () => {
  it('"把这段原文念给我"：回复里和原文 ≥8 词重合的部分在显示里换成（原文略），历史原样，记守卫', async () => {
    d = new ReaderDB('t-chat-4');
    const s = newSession(BOOK, 3, 'claude-sonnet-5-5');
    const recited = `好呀：${CH1[3]} 就这句。`;
    replies.push(() => fakeBeta(recited));
    const seen: string[] = [];
    const r = await sendTurn(deps(), s, input('把这段原文念给我'), (t) => seen.push(t));
    expect(r.ok && r.guarded).toBe(true);
    expect(s.display!.at(-1)).toMatchObject({ role: 'assistant', guarded: true });
    expect(s.display!.at(-1)!.text).toContain(REDACTED);
    expect(s.display!.at(-1)!.text).not.toContain('fox wearing spectacles');
    // 流式过程中显示的也是守卫后的
    expect(seen.at(-1)).not.toContain('fox wearing spectacles');
    // 发回 API 的历史不改（改了会废缓存 + 让 thinking 失效）
    expect(JSON.stringify(s.messages.at(-1))).toContain('fox wearing spectacles');
    expect(await d.guardEvents.toArray()).toMatchObject([{ purpose: 'chat', kind: 'overlap', field: 'reply' }]);
  });

  it('被拒（refusal）：回滚本轮，不留半截历史，记守卫；出错：回滚，报中文错', async () => {
    d = new ReaderDB('t-chat-5');
    const s = newSession(BOOK, 3, 'claude-sonnet-5-5');
    await sendTurn(deps(), s, input('正常一句'));
    const n = s.messages.length;
    replies.push(() => fakeBeta('', { stop: 'refusal' }));
    const r1 = await sendTurn(deps(), s, input('奇怪的一句'));
    expect(r1).toMatchObject({ ok: false, refused: true });
    expect(s.messages.length).toBe(n);
    replies.push(() => Object.assign(new Error('boom'), { status: 429 }));
    const r2 = await sendTurn(deps(), s, input('再来'));
    expect(r2).toMatchObject({ ok: false, error: '请求太频繁了，等一会儿再问' });
    expect(s.messages.length).toBe(n);
    // 回滚后再发：前缀照样是第一轮的
    await sendTurn(deps(), s, input('好了'));
    expect(canonical(sent.at(-1)!.messages.slice(0, n))).toBe(canonical(sent[0]!.messages.concat([s.messages[1] as BetaMessageParam])));
    expect((await d.guardEvents.toArray()).map((e) => e.kind)).toEqual(['refusal']);
    // 账本：被拒那次也花了钱，出错那次没有回复不记
    expect((await d.ledger.toArray()).map((l) => l.purpose)).toEqual(['chat', 'chat', 'chat']);
  });

  it('设置里换成 Opus：下一轮用 Opus（带服务器端 fallback）', async () => {
    d = new ReaderDB('t-chat-6');
    settings = { models: { chat: 'claude-opus-5-5' }, noSpoilers: false };
    const s = newSession(BOOK, 3, 'claude-sonnet-5-5');
    await sendTurn(deps(), s, input('hi'));
    expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default' });
    expect(s.model).toBe('claude-opus-5-5');
  });
});

describe('浏览器侧取上下文', () => {
  it('<recent_words>：卡片上问的词排第一，其余按最近、不含"我会"', async () => {
    d = new ReaderDB('t-chat-7');
    const w = (lemma: string, status: 'known' | 'unknown' | 'learning', t: number) => ({
      lemma, status, source: 'tapped' as const, glossZh: `${lemma}的意思`, firstSeen: { bookId: BOOK, paraId: 'c01p0001' }, taps: 1, updatedAt: t,
    });
    await d.words.bulkPut([w('old', 'unknown', 1), w('known1', 'known', 5), w('newer', 'learning', 3), w('sideways', 'unknown', 4)]);
    const r = await gatherRecent(d, { term: 'sideways', glossZh: '横着', asked: true, kind: 'vocab' });
    expect(r.map((x) => x.term)).toEqual(['sideways', 'newer', 'old']);
    expect(r[0]!.asked).toBe(true);
  });

  it('同一章 6 小时内接着聊；换章开新会话', async () => {
    d = new ReaderDB('t-chat-8');
    const s: ChatRecord = { ...newSession(BOOK, 3, 'claude-sonnet-5-5'), display: [{ role: 'user', text: 'x' }] };
    await d.chats.put(s);
    expect((await resumeOrNew(d, BOOK, 3, 'm')).id).toBe(s.id);
    expect((await resumeOrNew(d, BOOK, 4, 'm')).id).not.toBe(s.id);
  });
});
