/**
 * 按用途配模型（PLAN 2.8）。业务代码只说"我要做 annotate / tap / summary / chat"，
 * 不写死模型名、effort、max_tokens。模型升级只改这里；设置页可以按用途覆盖模型。
 *
 * 代理那边有一份模型白名单（functions/api/anthropic/[[path]].ts 的 ALLOWED_MODELS），
 * 这里出现的每个模型都必须在白名单里，test/roles.test.ts 会核对。
 */
import type { Purpose, Settings } from '../types';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 代理允许的全部模型（与代理白名单保持一致）。 */
export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export type ModelId = (typeof MODELS)[number];

export interface RoleConfig {
  label: string;
  model: ModelId;
  effort: Effort;
  /**
   * 正文 + 思考共用的 max_tokens 上限。代理卡 8000，这里不能超。
   * 真跑实测（2026-11-04）：Haiku 5.5 effort=medium 标注一组时 adaptive thinking 吃掉 ~4.3K，
   * 原来的 6000 只剩 ~1.7K 给 JSON，被截断。结构化输出撞上限时 callStructured 会用 effort=low 再发一次。
   */
  maxTokens: number;
}

export const ROLES: Record<Purpose, RoleConfig> = {
  annotate: { label: '自动标注', model: 'claude-haiku-5-5', effort: 'medium', maxTokens: 8000 },
  tap: { label: '点词补注', model: 'claude-haiku-5-5', effort: 'medium', maxTokens: 2000 },
  summary: { label: '章节摘要', model: 'claude-haiku-5-5', effort: 'medium', maxTokens: 4000 },
  chat: { label: '小克聊天', model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 4000 },
};

/** 聊天模型的可选项（设置页下拉框）。 */
export const CHAT_MODEL_OPTIONS: { id: ModelId; label: string }[] = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5（默认，约 $0.02 一轮）' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5（约 $0.04 一轮）' },
];

/** Haiku 被拒（stop_reason: "refusal"）时客户端重试用的模型。 */
export const REFUSAL_RETRY_MODEL: ModelId = 'claude-sonnet-5-5';

/** 服务器端 fallback 的 beta 头。代理的 beta 白名单里必须有它。 */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** 代理允许的 max_tokens 上限。 */
export const MAX_TOKENS_CAP = 8000;

export function isModelId(x: unknown): x is ModelId {
  return typeof x === 'string' && (MODELS as readonly string[]).includes(x);
}

/** 某个用途最终用哪个模型：设置里的覆盖（必须是白名单里的）> 默认表。 */
export function modelFor(purpose: Purpose, settings?: Pick<Settings, 'models'>): ModelId {
  const o = settings?.models[purpose];
  return isModelId(o) ? o : ROLES[purpose].model;
}

/** 某个模型能不能开服务器端 fallback（被安全分类器误拒时自动换模型重跑）。Haiku 5.5 没有，客户端自己用 REFUSAL_RETRY_MODEL 重试一次。 */
export function supportsServerFallback(model: ModelId): boolean {
  return model !== 'claude-haiku-5-5';
}
