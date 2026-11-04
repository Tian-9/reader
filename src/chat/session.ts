/**
 * 小克聊天的一轮：拼请求（context.ts）→ 流式调用 → 输出守卫 → 追加历史 → 记账 → 存库。
 *
 * 调 API 的函数从外面传进来（StreamFn）：浏览器里直连 Anthropic 的 SDK（browserStream），本地真跑脚本直连，单测是假的。
 *
 * 两份记录：
 * - messages：发给 API 的历史，只追加不改写。助手回复原样存（含 thinking 块和签名），守卫不碰它——
 *   改了历史，后面的 thinking 会失效、缓存从那里断掉（PLAN 2.9 + preserved thinking）。原文只会回到 Anthropic，不外流。
 * - display：她看到的。助手回复过守卫：和本章原文 ≥8 词连续重合的换成"（原文略）"。
 */
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ReaderDB } from '../db/db';
import { overlapIndex, redactOverlap } from '../annotate/guard';
import { storySoFar } from '../annotate/profile';
import { betaParams, getClient } from '../llm/client';
import { recordUsage } from '../llm/ledger';
import { CHAT_EN_MODE, CHAT_ZH_MODE } from '../llm/prompts/chat';
import { modelFor, type ModelId } from '../llm/roles';
import type { ChatLine, ChatRecord, LedgerEntry, Settings } from '../types';
import {
  CHAT_STORY_MAX_CHARS,
  RECENT_MAX,
  SESSION_MAX_BYTES,
  chatSystem,
  langSwitch,
  pickScreen,
  storyBlock,
  userTurn,
  withTailBreakpoint,
  type RecentWord,
  type ScreenPara,
  type TurnContext,
} from './context';

export type StreamFn = (params: BetaMessageStreamParams, onText: (delta: string) => void) => Promise<BetaMessage>;

export interface ChatDeps {
  d: ReaderDB;
  stream: StreamFn;
  /** 每轮现读（设置可能中途改了） */
  settings: () => Pick<Settings, 'models' | 'noSpoilers'>;
  log?: (msg: string, data?: unknown) => void;
}

export interface TurnInput {
  question: string;
  book: { title: string; author?: string };
  turn: TurnContext;
  /** 守卫比对用的原文（本章全部段落 + 屏幕段落） */
  guardSources: string[];
}

export type TurnResult =
  | { ok: true; text: string; guarded: boolean; ledger: LedgerEntry; request: BetaMessageStreamParams; message: BetaMessage }
  | { ok: false; error: string; refused?: boolean; request?: BetaMessageStreamParams };

let seq = 0;
export function newSession(bookId: string, chapter: number, model: string, lang: 'zh' | 'en' = 'zh'): ChatRecord {
  const now = Date.now();
  return {
    id: `${now.toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    bookId,
    lang,
    messages: [],
    createdAt: now,
    updatedAt: now,
    chapter,
    model,
    display: [],
  };
}

/** 历史里最后一次中英指令是什么（没有 = 中文）。 */
export function effectiveLang(messages: readonly unknown[]): 'zh' | 'en' {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role: string; content?: unknown };
    if (m.role !== 'system') continue;
    if (m.content === CHAT_EN_MODE) return 'en';
    if (m.content === CHAT_ZH_MODE) return 'zh';
  }
  return 'zh';
}

function textOf(msg: BetaMessage): string {
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function errorText(e: unknown): string {
  const status = (e as { status?: number }).status;
  const inner = (e as { error?: { error?: { message?: unknown } } }).error?.error?.message;
  if (status === 401) return 'API key 不对（Anthropic 不认），去设置里改一下';
  if (status === 403) return `这个 API key 没权限（${String(inner ?? 403)}）`;
  if (status === 429) return '请求太频繁了，等一会儿再问';
  if (status && status >= 500) return `Anthropic 那边出错了（${status}），过一会儿再试`;
  if (status) return `请求被拒了（${status}）：${String(inner ?? (e as Error).message)}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * 跑一轮。s 会被就地修改（追加历史、显示行），调用方存的是普通对象（Svelte 里用 $state.raw，改完重新赋值触发刷新）。
 * onText 收到的是"过了守卫的完整回复"（不是增量），直接显示即可。
 */
export async function sendTurn(deps: ChatDeps, s: ChatRecord, input: TurnInput, onText?: (guarded: string) => void): Promise<TurnResult> {
  const { d } = deps;
  const settings = deps.settings();
  const model: ModelId = modelFor('chat', settings);
  s.model = model;
  s.display ??= [];

  const before = s.messages.length;
  const story = before === 0 ? storyBlock(input.book, await storySoFar(d, s.bookId, s.chapter ?? input.turn.chapter, CHAT_STORY_MAX_CHARS)) : undefined;
  const msgs = s.messages as BetaMessageParam[];
  msgs.push(userTurn(input.question, input.turn, story));
  const switched = effectiveLang(msgs) !== s.lang;
  if (switched) msgs.push(langSwitch(s.lang));

  const request: BetaMessageStreamParams = {
    ...betaParams('chat', settings, model),
    system: chatSystem(),
    messages: withTailBreakpoint(msgs),
  };
  const rollback = () => msgs.splice(before);

  if (JSON.stringify(request).length > SESSION_MAX_BYTES) {
    rollback();
    return { ok: false, error: 'too-long' };
  }

  const index = overlapIndex(input.guardSources);
  let acc = '';
  let msg: BetaMessage;
  try {
    msg = await deps.stream(request, (delta) => {
      acc += delta;
      onText?.(redactOverlap(acc, index).text);
    });
  } catch (e) {
    rollback();
    deps.log?.('[chat] 出错', String(e));
    return { ok: false, error: errorText(e), request };
  }

  const ledger = await recordUsage(d, { purpose: 'chat', model: msg.model || model, usage: msg.usage, bookId: s.bookId });
  deps.log?.('[chat] usage', { model: msg.model, ...msg.usage });

  const raw = textOf(msg);
  if (msg.stop_reason === 'refusal' || !raw.trim()) {
    rollback();
    if (msg.stop_reason === 'refusal') await d.guardEvents.add({ ts: Date.now(), bookId: s.bookId, purpose: 'chat', kind: 'refusal' });
    return { ok: false, refused: msg.stop_reason === 'refusal', error: msg.stop_reason === 'refusal' ? '这句它没接（被安全检查拦了），换个说法试试' : '没收到回复，再发一次试试', request };
  }

  // 历史：原样追加（thinking 块、签名一个字不改）
  msgs.push({ role: 'assistant', content: msg.content as unknown as BetaContentBlockParam[] });

  const g = redactOverlap(raw, index);
  if (g.hit) await d.guardEvents.add({ ts: Date.now(), bookId: s.bookId, purpose: 'chat', kind: 'overlap', field: 'reply' });
  const lines: ChatLine[] = [];
  if (switched) lines.push({ role: 'note', text: s.lang === 'en' ? '已切到英文模式' : '已切回中文' });
  lines.push({ role: 'user', text: input.question });
  lines.push({ role: 'assistant', text: g.text, ...(g.hit ? { guarded: true } : {}) });
  if (msg.stop_reason === 'max_tokens') lines.push({ role: 'note', text: '回复太长被截断了' });
  s.display.push(...lines);
  s.updatedAt = Date.now();
  await d.chats.put(structuredClone(s));
  return { ok: true, text: g.text, guarded: g.hit, ledger, request, message: msg };
}

// ───────────────── 浏览器侧：取屏幕段落、最近的词、会话 ─────────────────

/** 屏幕上的段落（按可见顺序），截到 600 词；mustId（她问的词所在段）一定带上。 */
export async function gatherScreen(d: ReaderDB, bookId: string, visibleIds: readonly string[], mustId?: string): Promise<ScreenPara[]> {
  const ids = [...visibleIds];
  if (mustId && !ids.includes(mustId)) ids.unshift(mustId);
  const rows = await d.paras.bulkGet(ids.map((id) => [bookId, id] as [string, string]));
  const paras = rows.filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => a.chapter - b.chapter || a.idx - b.idx);
  return pickScreen(paras.map((p) => ({ id: p.id, text: p.text })), mustId);
}

/** <recent_words>：她刚问的那个排第一，然后是最近点过/在学/不认识的词（不含"我会"的）。 */
export async function gatherRecent(d: ReaderDB, focus?: RecentWord): Promise<RecentWord[]> {
  const rows = await d.words.orderBy('updatedAt').reverse().filter((w) => w.status !== 'known').limit(RECENT_MAX).toArray();
  const out: RecentWord[] = focus ? [focus] : [];
  for (const w of rows) {
    if (out.some((r) => r.term.toLowerCase() === w.lemma.toLowerCase())) continue;
    out.push({ term: w.lemma, glossZh: w.glossZh, kind: 'vocab' });
  }
  return out.slice(0, RECENT_MAX);
}

/** 这本书最近的会话：同一章、6 小时内说过话就接着聊，否则开新的（前情摘要跟着当前章）。 */
export async function resumeOrNew(d: ReaderDB, bookId: string, chapter: number, model: string): Promise<ChatRecord> {
  const rows = await d.chats.where('bookId').equals(bookId).toArray();
  const last = rows.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0];
  if (last && last.chapter === chapter && Date.now() - (last.updatedAt ?? last.createdAt) < 6 * 3600_000) {
    return { ...last, display: last.display ?? [] };
  }
  return newSession(bookId, chapter, model);
}

/** 浏览器里用：拿设置里的 key 直连 Anthropic，流式。SDK 第一次发请求时才加载。 */
export function browserStream(getKey: () => string): StreamFn {
  return async (params, onText) => {
    const c = await getClient(getKey());
    const s = c.beta.messages.stream(params);
    s.on('text', (delta) => onText(delta));
    return s.finalMessage();
  };
}
