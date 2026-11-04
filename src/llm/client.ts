/**
 * Anthropic SDK 客户端（直连模式，PLAN 2.6）：浏览器拿她在设置页填的 API key 直接打 https://api.anthropic.com。
 * key 只存在这台手机的 IndexedDB（Dexie settings 表，和 pocketverse 同款），不进备份、不进仓库、不经过任何服务器。
 * 业务代码用法（T3/T4）：
 *
 *   const c = await getClient(settings.apiKey);
 *   const p = baseParams('annotate', settings);           // model / max_tokens / thinking / effort
 *   const msg = await c.messages.create({ ...p, system, messages, output_config: { ...p.output_config, format } });
 *
 *   // 聊天（流式 + 服务器端 fallback 走 beta 接口）：
 *   const s = c.beta.messages.stream({ ...betaParams('chat', settings), system, messages });
 *
 * - CSP 是 connect-src 'self' https://api.anthropic.com，页面只能连 Anthropic，连不了别的第三方。
 * - 浏览器直连要 dangerouslyAllowBrowser + `anthropic-dangerous-direct-browser-access: true` 头，Anthropic 才回 CORS 头。
 * - 原代理的白名单（模型 / max_tokens / beta / fallbacks / fast mode / 体积）由 guardedFetch 在发出前查（roles.ts 的 checkRequest）。
 * - SDK 约 360KB，第一次调 API 时才动态加载，阅读外壳不等它。类型照常静态 import（不进包）。
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Purpose, Settings } from '../types';
import { FALLBACK_BETA, ROLES, checkRequest, modelFor, supportsServerFallback, type ModelId } from './roles';

export const API_BASE = 'https://api.anthropic.com';
/** 白名单拦下的请求在本地回的 400 里带这个前缀，方便和 Anthropic 回的 400 区分。 */
export const LOCAL_BLOCK_PREFIX = '本地拦下：';

/** 从 API 错误体 {type:'error', error:{message}} 里取 message。 */
function apiErrorMessage(body: unknown): string | undefined {
  const m = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof m === 'string' ? m : undefined;
}

function headerOf(h: HeadersInit | undefined, name: string): string | null {
  return h ? new Headers(h).get(name) : null;
}

/**
 * 交给 SDK 的 fetch：发出前过一遍白名单，不过就本地回一个 Anthropic 格式的错误（SDK 照常抛 APIError，4xx 不重试），
 * 请求根本不出浏览器。过了就原样交给浏览器的 fetch。
 */
export async function guardedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const body = typeof init?.body === 'string' ? init.body : init?.body == null && method.toUpperCase() !== 'POST' ? '' : null;
  const problem = checkRequest({ method, url, beta: headerOf(init?.headers, 'anthropic-beta'), body });
  if (problem) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: LOCAL_BLOCK_PREFIX + problem.message } }), {
      status: problem.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  return fetch(input, init);
}

let cached: { key: string; client: Anthropic } | null = null;

/** 动态加载 SDK 模块（只加载一次）。错误类（Anthropic.APIError 等）也从这里拿。 */
export function loadSdk(): Promise<typeof import('@anthropic-ai/sdk')> {
  return import('@anthropic-ai/sdk');
}

/** 按 API key 拿客户端（key 变了就换一个）。没填 key 时抛 NoKeyError，界面上提示去设置页。 */
export async function getClient(apiKey: string): Promise<Anthropic> {
  const key = apiKey.trim();
  if (!key) throw new NoKeyError();
  if (cached?.key === key) return cached.client;
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({
    apiKey: key,
    baseURL: API_BASE,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' },
    fetch: guardedFetch,
    maxRetries: 2,
  });
  cached = { key, client };
  return client;
}

export class NoKeyError extends Error {
  constructor() {
    super('还没填 API key，去设置页填一下');
    this.name = 'NoKeyError';
  }
}

/** 某用途的基础参数（非 beta 接口）：模型、上限、adaptive thinking、effort。 */
export function baseParams(purpose: Purpose, settings?: Pick<Settings, 'models'>, model?: ModelId) {
  const role = ROLES[purpose];
  return {
    model: model ?? modelFor(purpose, settings),
    max_tokens: role.maxTokens,
    thinking: { type: 'adaptive' as const },
    output_config: { effort: role.effort },
  };
}

/** beta 接口参数：在基础参数上，按模型决定要不要带服务器端 fallback。 */
export function betaParams(purpose: Purpose, settings?: Pick<Settings, 'models'>, model?: ModelId) {
  const p = baseParams(purpose, settings, model);
  return supportsServerFallback(p.model)
    ? { ...p, betas: [FALLBACK_BETA], fallbacks: 'default' as const }
    : p;
}

/** 设置页"测一下"：直连发一句最短的 Haiku 请求，看 key 和网络是不是通的。花费不到 $0.0001。 */
export async function ping(apiKey: string): Promise<{ ok: true; model: string } | { ok: false; status?: number; message: string }> {
  try {
    const { default: Anthropic } = await loadSdk();
    try {
      const client = await getClient(apiKey);
      const msg = await client.messages.create({
        model: 'claude-haiku-5-5',
        max_tokens: 64,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: '回一个字：好' }],
      });
      return { ok: true, model: msg.model };
    } catch (e) {
      if (e instanceof NoKeyError) return { ok: false, message: e.message };
      if (e instanceof Anthropic.AuthenticationError) return { ok: false, status: 401, message: 'API key 不对（Anthropic 不认）' };
      if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, status: 403, message: `这个 key 没权限：${apiErrorMessage(e.error) ?? ''}` };
      if (e instanceof Anthropic.APIConnectionError) return { ok: false, message: '连不上 api.anthropic.com（断网了？）' };
      if (e instanceof Anthropic.APIError) return { ok: false, status: e.status, message: apiErrorMessage(e.error) ?? e.message };
      return { ok: false, message: String(e) };
    }
  } catch (e) {
    return { ok: false, message: `SDK 没加载出来：${String(e)}` };
  }
}
