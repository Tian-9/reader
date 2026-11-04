/**
 * 按用途配模型（PLAN 2.8）。业务代码只说"我要做 annotate / tap / summary / chat"，
 * 不写死模型名、effort、max_tokens。模型升级只改这里；设置页可以按用途覆盖模型。
 *
 * 直连模式（PLAN 2.6）：浏览器拿她自己的 key 直接打 api.anthropic.com，没有代理替我们把关了。
 * 原来代理里的白名单（模型 / max_tokens / beta 头 / fallbacks / fast mode / 请求体大小）挪到这里，
 * 由 client.ts 的 guardedFetch 在每个请求发出去之前查一遍（checkRequest）。test/roles.test.ts 核对。
 */
import type { Purpose, Settings } from '../types';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 允许的全部模型（白名单）。ROLES、聊天可选项、拒答重试模型都必须在这里面。 */
export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export type ModelId = (typeof MODELS)[number];

export interface RoleConfig {
  label: string;
  model: ModelId;
  effort: Effort;
  /**
   * 正文 + 思考共用的 max_tokens 上限。请求闸门卡 MAX_TOKENS_CAP（8000），这里不能超。
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

/** 服务器端 fallback 的 beta 头。ALLOWED_BETAS 里必须有它。 */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** 允许的 max_tokens 上限。 */
export const MAX_TOKENS_CAP = 8000;

/** 白名单的 Set 形式（checkRequest 用）。 */
export const ALLOWED_MODELS: ReadonlySet<string> = new Set(MODELS);
/** 允许的 anthropic-beta 头。新增 beta 先加这里，不然请求在本地就被拦成 400。 */
export const ALLOWED_BETAS: ReadonlySet<string> = new Set([FALLBACK_BETA]);
/** 一次最多发约 900 词正文 + 摘要 + 聊天历史，256KB 绰绰有余；再大就是不对劲（聊天 180KB 就自动开新话题）。 */
export const MAX_BODY_BYTES = 256 * 1024;

/** 校验请求体字段。返回 null 表示通过，否则返回错误说明。只看字段，不碰正文内容。 */
export function checkBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '请求体必须是 JSON 对象';
  const b = body as Record<string, unknown>;
  if (typeof b.model !== 'string' || !ALLOWED_MODELS.has(b.model)) return `model 不在白名单里：${String(b.model)}`;
  if (typeof b.max_tokens !== 'number' || !Number.isInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > MAX_TOKENS_CAP) {
    return `max_tokens 必须是 1-${MAX_TOKENS_CAP} 的整数`;
  }
  // 数组形式能指定任意模型，等于绕过白名单
  if (b.fallbacks !== undefined && b.fallbacks !== 'default') return 'fallbacks 只允许 "default"';
  if (b.speed !== undefined && b.speed !== 'standard') return '不允许 fast mode';
  return null;
}

/** 校验 anthropic-beta 头（逗号分隔）。返回不在白名单里的那些。 */
export function badBetas(header: string | null | undefined): string[] {
  if (!header) return [];
  return header.split(',').map((s) => s.trim()).filter((s) => s && !ALLOWED_BETAS.has(s));
}

/**
 * 一个请求能不能发出去（原代理的第 2、3 步）：只允许 POST /v1/messages（可带 ?beta=true）、
 * beta 头白名单、请求体 ≤ MAX_BODY_BYTES、checkBody。返回 null 表示放行，否则返回 { status, message }。
 */
export function checkRequest(req: { method: string; url: string; beta: string | null; body: string | null }): { status: number; message: string } | null {
  const u = new URL(req.url);
  if (u.pathname !== '/v1/messages') return { status: 404, message: `只开放 /v1/messages：${u.pathname}` };
  if (req.method.toUpperCase() !== 'POST') return { status: 405, message: '只允许 POST' };
  if (u.search !== '' && u.search !== '?beta=true') return { status: 400, message: '不允许的查询参数' };
  const bad = badBetas(req.beta);
  if (bad.length) return { status: 400, message: `beta 不在白名单里：${bad.join(', ')}` };
  if (req.body === null) return { status: 400, message: '请求体必须是 JSON 字符串' };
  if (new TextEncoder().encode(req.body).byteLength > MAX_BODY_BYTES) return { status: 413, message: `请求体超过 ${MAX_BODY_BYTES} 字节` };
  let body: unknown;
  try {
    body = JSON.parse(req.body);
  } catch {
    return { status: 400, message: '请求体不是合法 JSON' };
  }
  const problem = checkBody(body);
  return problem ? { status: 400, message: problem } : null;
}

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
