/**
 * Anthropic SDK 客户端。地址指向同站代理 /api/anthropic，apiKey 填的是"应用口令"，真 key 只在代理的环境变量里。
 * 业务代码用法（T3/T4）：
 *
 *   const c = await getClient(settings.appToken);
 *   const p = baseParams('annotate', settings);           // model / max_tokens / thinking / effort
 *   const msg = await c.messages.create({ ...p, system, messages, output_config: { ...p.output_config, format } });
 *
 *   // 聊天（流式 + 服务器端 fallback 走 beta 接口）：
 *   const s = c.beta.messages.stream({ ...betaParams('chat', settings), system, messages });
 *
 * CSP 是 connect-src 'self'，这个客户端只能连同站代理，连不了任何别的地址。
 * SDK 约 360KB，第一次调 API 时才动态加载，阅读外壳不等它。类型照常静态 import（不进包）。
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Purpose, Settings } from '../types';
import { FALLBACK_BETA, ROLES, modelFor, supportsServerFallback, type ModelId } from './roles';

export const PROXY_PATH = '/api/anthropic';
/** 代理口令不对时的报错文案（和 functions/api/anthropic/[[path]].ts 一致，test/proxy.test.ts 核对）。 */
export const PROXY_BAD_TOKEN = '应用口令不对';

/** 从 API 错误体 {type:'error', error:{message}} 里取 message。 */
function apiErrorMessage(body: unknown): string | undefined {
  const m = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof m === 'string' ? m : undefined;
}

let cached: { token: string; client: Anthropic } | null = null;

/** 动态加载 SDK 模块（只加载一次）。错误类（Anthropic.APIError 等）也从这里拿。 */
export function loadSdk(): Promise<typeof import('@anthropic-ai/sdk')> {
  return import('@anthropic-ai/sdk');
}

/** 按口令拿客户端（口令变了就换一个）。没设口令时抛 NoTokenError，界面上提示去设置页。 */
export async function getClient(appToken: string): Promise<Anthropic> {
  if (!appToken) throw new NoTokenError();
  if (cached?.token === appToken) return cached.client;
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({
    baseURL: `${location.origin}${PROXY_PATH}`,
    apiKey: appToken,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
  cached = { token: appToken, client };
  return client;
}

export class NoTokenError extends Error {
  constructor() {
    super('还没设应用口令，去设置页填一下');
    this.name = 'NoTokenError';
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

/** 设置页"测一下口令"：发一句最短的 Haiku 请求，看代理和口令是不是通的。花费不到 $0.0001。 */
export async function ping(appToken: string): Promise<{ ok: true; model: string } | { ok: false; status?: number; message: string }> {
  const { default: Anthropic } = await loadSdk();
  try {
    const client = await getClient(appToken);
    const msg = await client.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 64,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: '回一个字：好' }],
    });
    return { ok: true, model: msg.model };
  } catch (e) {
    if (e instanceof NoTokenError) return { ok: false, message: e.message };
    if (e instanceof Anthropic.APIError) {
      const detail = apiErrorMessage(e.error);
      // 代理自己拒的 401 和上游拒真 key 的 401 要分开说，不然分不清是口令错还是服务器 key 坏了
      if (e.status === 401) {
        return detail === PROXY_BAD_TOKEN
          ? { ok: false, status: 401, message: '应用口令不对' }
          : { ok: false, status: 401, message: `口令对了，但服务器上的 API key 被 Anthropic 拒了：${detail ?? '未知原因'}` };
      }
      return { ok: false, status: e.status, message: detail ?? e.message };
    }
    return { ok: false, message: String(e) };
  }
}
