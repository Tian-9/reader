/**
 * Anthropic 代理（PLAN 2.6）。只做三件事：认人、换钥匙、限额。
 *   1. 口令必须等于 APP_TOKEN，否则 401。口令可以放 x-api-key（curl、旧 SDK），也可以放 Authorization: Bearer
 *      （@anthropic-ai/sdk 1.x 把 apiKey 一律这样发，PLAN 写稿时按的是旧 SDK）。这两个头都不会转发到上游。
 *   2. 只允许 POST /v1/messages（SDK 的 beta 接口会带 ?beta=true，放行）
 *   3. model 白名单、max_tokens ≤ 8000、anthropic-beta 头白名单；fallbacks 只允许 "default"（数组形式能指定任意模型，等于绕过白名单）
 *   4. 换成真 key ANTHROPIC_API_KEY 转发到 api.anthropic.com，响应体原样流式透传（不缓冲，SSE 才是流式）
 *   5. 不打印、不存储请求正文和响应正文
 * 环境变量：APP_TOKEN、ANTHROPIC_API_KEY（`wrangler pages secret put`，她自己敲）。
 * 模型白名单和 src/llm/roles.ts 的 MODELS 必须一致，test/roles.test.ts 核对。
 */

export interface Env {
  APP_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
}

/** Pages Functions 传进来的上下文，只用到这两个字段（不引 workers-types，保持代理独立好读）。 */
interface Ctx {
  request: Request;
  env: Env;
}

export const UPSTREAM = 'https://api.anthropic.com';
export const ALLOWED_MODELS = new Set(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
export const ALLOWED_BETAS = new Set(['server-side-fallback-2026-07-01']);
export const MAX_TOKENS = 8000;
/** 一次最多发约 900 词正文 + 摘要 + 聊天历史，256KB 绰绰有余；再大就是不对劲。 */
export const MAX_BODY_BYTES = 256 * 1024;
/** 只转发这几个请求头，其余（cookie、浏览器直连标记、SDK 遥测头）一律丢掉。 */
const FORWARD_HEADERS = ['content-type', 'anthropic-version', 'accept'];

function err(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** 常数时间比较口令：两边先各做 SHA-256，再逐字节异或，避免按字节提前返回泄露口令长度/前缀。 */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** 取请求里的应用口令：x-api-key 优先，其次 Authorization: Bearer。 */
export function tokenFrom(request: Request): string {
  const k = request.headers.get('x-api-key');
  if (k) return k;
  return /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim() ?? '';
}

/** 校验请求体。返回 null 表示通过，否则返回错误说明。只看字段，不碰正文内容。 */
export function checkBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '请求体必须是 JSON 对象';
  const b = body as Record<string, unknown>;
  if (typeof b.model !== 'string' || !ALLOWED_MODELS.has(b.model)) return `model 不在白名单里：${String(b.model)}`;
  if (typeof b.max_tokens !== 'number' || !Number.isInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > MAX_TOKENS) {
    return `max_tokens 必须是 1-${MAX_TOKENS} 的整数`;
  }
  if (b.fallbacks !== undefined && b.fallbacks !== 'default') return 'fallbacks 只允许 "default"';
  if (b.speed !== undefined && b.speed !== 'standard') return '不允许 fast mode';
  return null;
}

/** 校验 anthropic-beta 头（逗号分隔）。返回不在白名单里的那些。 */
export function badBetas(header: string | null): string[] {
  if (!header) return [];
  return header.split(',').map((s) => s.trim()).filter((s) => s && !ALLOWED_BETAS.has(s));
}

export async function onRequest({ request, env }: Ctx): Promise<Response> {
  // 1. 认人（先认人再说别的，没口令的人什么都探不到）
  if (!env.APP_TOKEN || !env.ANTHROPIC_API_KEY) return err(500, 'api_error', '代理没配置好：缺 APP_TOKEN 或 ANTHROPIC_API_KEY');
  const given = tokenFrom(request);
  if (!given || !(await tokenMatches(given, env.APP_TOKEN))) return err(401, 'authentication_error', '应用口令不对');

  // 2. 只允许 POST /v1/messages（可带 ?beta=true）
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/anthropic/, '');
  if (path !== '/v1/messages') return err(404, 'not_found_error', `代理只开放 /v1/messages：${path}`);
  if (request.method !== 'POST') return err(405, 'invalid_request_error', '只允许 POST');
  const query = url.search;
  if (query !== '' && query !== '?beta=true') return err(400, 'invalid_request_error', '不允许的查询参数');

  // 3. 限额：beta 头、请求体大小、模型、max_tokens
  const betaHeader = request.headers.get('anthropic-beta');
  const bad = badBetas(betaHeader);
  if (bad.length) return err(400, 'invalid_request_error', `beta 不在白名单里：${bad.join(', ')}`);

  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return err(413, 'request_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节`);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return err(400, 'invalid_request_error', '请求体不是合法 JSON');
  }
  const problem = checkBody(body);
  if (problem) return err(400, 'invalid_request_error', problem);

  // 4. 换钥匙转发，响应体原样流式透传
  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  if (betaHeader) headers.set('anthropic-beta', betaHeader);
  headers.set('x-api-key', env.ANTHROPIC_API_KEY);

  const upstream = await fetch(`${UPSTREAM}/v1/messages${query}`, { method: 'POST', headers, body: raw });

  // 5. 只回传需要的响应头；正文是 ReadableStream，不读、不缓冲、不记录
  const out = new Headers();
  for (const h of ['content-type', 'request-id', 'retry-after', 'x-should-retry', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-tokens-remaining']) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
