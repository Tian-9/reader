/**
 * 小克聊天的上下文组装（PLAN 2.9），全是纯函数，单测直接测。
 *
 *   system  = CHAT_SYSTEM                                     ← 断点 1（永远不变）
 *   messages[0] (user)
 *     block 0 = <book> + <story_so_far>                       ← 断点 2（会话开始时定下，整个会话不变）
 *     block 1 = 本轮的 <reading> <screen> <recent_words>
 *     block 2 = 她的问题
 *   messages[1] (assistant) = 模型原样返回的 content（含 thinking 块，不改一个字）
 *   [role: system]  = 切中/英文时追加，紧跟在那一轮的 user 后面（API 要求：跟在 user 后、后面是 assistant 或结尾）
 *   …
 *   最后一条 user 的最后一块                                    ← 断点 3（每轮往后挪，让整段历史都能被缓存）
 *
 * 规矩（缓存 + preserved thinking 都靠它）：历史只追加不改写。易变的东西（屏幕段落、最近的词、防剧透开关、章号）
 * 只出现在"本轮"的 user 消息里，发出去以后就是历史，下一轮不再改它。
 */
import type { BetaContentBlockParam, BetaMessageParam, BetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { CHAT_EN_MODE, CHAT_SYSTEM, CHAT_ZH_MODE } from '../llm/prompts/chat';

export const EPHEMERAL = { type: 'ephemeral' as const };

/** 屏幕段落最多带这么多词（够看清上下文，又不至于每轮塞一大坨） */
export const SCREEN_MAX_WORDS = 600;
/** <recent_words> 最多几个 */
export const RECENT_MAX = 8;
/** 聊天用的前情摘要上限（标注那边是 600 字） */
export const CHAT_STORY_MAX_CHARS = 1500;
/** 请求体估算超过这个就开新会话（代理卡 256KB） */
export const SESSION_MAX_BYTES = 180_000;

export interface ScreenPara {
  id: string;
  text: string;
}

export interface RecentWord {
  /** 词（lemma）或"有意思"的那几个字 */
  term: string;
  glossZh: string;
  noteZh?: string;
  kind?: 'vocab' | 'fun';
  /** 她刚从卡片上点"问小克"问的这个 */
  asked?: boolean;
}

export interface TurnContext {
  chapter: number;
  chapterTitle: string;
  noSpoilers: boolean;
  screen: ScreenPara[];
  recent: RecentWord[];
}

/** system：只有小克人格，打断点 1。 */
export function chatSystem(): BetaTextBlockParam[] {
  return [{ type: 'text', text: CHAT_SYSTEM, cache_control: EPHEMERAL }];
}

/** 会话第一条 user 消息的第一块：书名 + 前情摘要。整个会话不变，打断点 2。 */
export function storyBlock(book: { title: string; author?: string }, story: string): BetaTextBlockParam {
  const t = story.trim() || '（还没有前情摘要：可能刚开始读，或者前面的章节还没生成摘要）';
  return {
    type: 'text',
    text: `<book>${book.title}${book.author ? ` · ${book.author}` : ''}</book>\n<story_so_far>\n${t}\n</story_so_far>`,
    cache_control: EPHEMERAL,
  };
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * 屏幕段落按词数截：优先保住"必须带"的那段（她问的词所在段），其余按阅读顺序往里放，放满为止。
 * 返回按阅读顺序排好的段落。
 */
export function pickScreen(paras: ScreenPara[], mustId?: string, max = SCREEN_MAX_WORDS): ScreenPara[] {
  const keep = new Set<string>();
  let n = 0;
  const must = mustId ? paras.find((p) => p.id === mustId) : undefined;
  if (must) {
    keep.add(must.id);
    n += words(must.text);
  }
  for (const p of paras) {
    if (keep.has(p.id)) continue;
    const w = words(p.text);
    if (n + w > max && keep.size) break;
    keep.add(p.id);
    n += w;
  }
  return paras.filter((p) => keep.has(p.id));
}

/** 本轮的上下文块（易变，只进本轮 user 消息）。 */
export function turnContextText(c: TurnContext): string {
  const screen = c.screen.map((p) => `[${p.id}] ${p.text.replace(/\s*\n\s*/g, ' ')}`).join('\n');
  const recent = c.recent
    .slice(0, RECENT_MAX)
    .map((w) => {
      const head = w.kind === 'fun' ? `※「${w.term}」` : w.term;
      const body = [w.glossZh, w.noteZh].filter(Boolean).join('；');
      return `${head}：${body || '（没有小注）'}${w.asked ? '（她刚点了"问小克"问的就是这个）' : ''}`;
    })
    .join('\n');
  return [
    `<reading>读到第${c.chapter}章「${c.chapterTitle}」；防剧透：${c.noSpoilers ? `开（只知道读到第${c.chapter}章这块为止的内容）` : '关（可以聊全书）'}</reading>`,
    '<screen>',
    screen || '（屏幕上没有正文）',
    '</screen>',
    '<recent_words>',
    recent || '（最近没点过词）',
    '</recent_words>',
  ].join('\n');
}

/** 卡片上点"问小克"后输入框里预填的问题。 */
export function askPrefill(r: RecentWord): string {
  return r.kind === 'fun' ? `「${r.term}」这里有什么梗？` : `「${r.term}」在这儿是什么意思？`;
}

/** 本轮新 user 消息。第一轮会把前情块放在最前面。 */
export function userTurn(question: string, ctx: TurnContext, story?: BetaTextBlockParam): BetaMessageParam {
  const content: BetaContentBlockParam[] = [];
  if (story) content.push(story);
  content.push({ type: 'text', text: turnContextText(ctx) });
  content.push({ type: 'text', text: question });
  return { role: 'user', content };
}

/** 中英切换的中途 system 消息。 */
export function langSwitch(to: 'zh' | 'en'): BetaMessageParam {
  return { role: 'system', content: to === 'en' ? CHAT_EN_MODE : CHAT_ZH_MODE };
}

/**
 * 把存着的历史变成这一次请求的 messages：深拷贝，只在"最后一条 user 消息的最后一块"上加断点 3。
 * 历史本身不动（前情块上的断点 2 是存在历史里的，永远在同一个位置）。
 */
export function withTailBreakpoint(history: readonly BetaMessageParam[]): BetaMessageParam[] {
  const out = structuredClone(history) as BetaMessageParam[];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') m.content = [{ type: 'text', text: m.content, cache_control: EPHEMERAL }];
    else {
      const last = m.content[m.content.length - 1] as { cache_control?: unknown } | undefined;
      if (last && typeof last === 'object') last.cache_control = EPHEMERAL;
    }
    break;
  }
  return out;
}

/** 去掉所有 cache_control 后的 JSON：用来比"前缀是不是一字不差"（断点挪位置不算改动）。 */
export function canonical(x: unknown): string {
  return JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v));
}

/** 一次请求的断点数（API 上限 4）。 */
export function countBreakpoints(system: readonly unknown[], messages: readonly unknown[]): number {
  return (canonicalCount(system) + canonicalCount(messages));
}
function canonicalCount(x: unknown): number {
  return (JSON.stringify(x).match(/"cache_control"/g) ?? []).length;
}
