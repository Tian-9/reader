import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest, checkBody, badBetas, ALLOWED_MODELS, MAX_TOKENS } from '../functions/api/anthropic/[[path]]';
import { PROXY_BAD_TOKEN } from '../src/llm/client';

const env = { APP_TOKEN: 'tok-123', ANTHROPIC_API_KEY: 'sk-real' };
const BASE = 'https://reader.pages.dev/api/anthropic';
const okBody = { model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

function req(path = '/v1/messages', init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const { method = 'POST', headers = { 'x-api-key': 'tok-123' }, body = okBody } = init;
  return new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'anthropic-version': '2026-10-21', ...headers },
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

async function call(r: Request, e: typeof env | Record<string, string> = env) {
  const res = await onRequest({ request: r, env: e });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

afterEach(() => vi.unstubAllGlobals());

describe('代理：认人', () => {
  it('不带口令 → 401', async () => {
    const r = await call(req('/v1/messages', { headers: {} }));
    expect(r.status).toBe(401);
    expect(r.json.error.type).toBe('authentication_error');
  });
  it('口令错 → 401，文案和前端约定的一致（前端靠它区分"口令错"和"上游 key 坏了"）', async () => {
    const r = await call(req('/v1/messages', { headers: { 'x-api-key': 'tok-12' } }));
    expect(r.status).toBe(401);
    expect(r.json.error.message).toBe(PROXY_BAD_TOKEN);
  });
  it('SDK 1.x 的 Authorization: Bearer 口令也认；Bearer 错 → 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect((await call(req('/v1/messages', { headers: { authorization: 'Bearer tok-123' } }))).status).toBe(200);
    expect((await call(req('/v1/messages', { headers: { authorization: 'Bearer tok-999' } }))).status).toBe(401);
    expect((await call(req('/v1/messages', { headers: { authorization: 'tok-123' } }))).status).toBe(401);
  });
  it('没带口令时连路径都不暴露（先 401 再 404）', async () => {
    expect((await call(req('/v1/models', { method: 'GET', headers: {} }))).status).toBe(401);
  });
  it('环境变量没配 → 500，不转发', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await call(req(), { APP_TOKEN: 'tok-123' })).status).toBe(500);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('代理：只开 POST /v1/messages', () => {
  it('别的路径 → 404', async () => {
    expect((await call(req('/v1/messages/count_tokens'))).status).toBe(404);
    expect((await call(req('/v1/models', { method: 'GET' }))).status).toBe(404);
  });
  it('GET /v1/messages → 405', async () => {
    expect((await call(req('/v1/messages', { method: 'GET' }))).status).toBe(405);
  });
  it('只放行 ?beta=true 这一个查询参数', async () => {
    expect((await call(req('/v1/messages?foo=1'))).status).toBe(400);
  });
});

describe('代理：限额', () => {
  it('模型不在白名单 → 400', async () => {
    const r = await call(req('/v1/messages', { body: { ...okBody, model: 'claude-fable-5-1' } }));
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('claude-fable-5-1');
  });
  it('max_tokens 超过 8000 → 400', async () => {
    expect((await call(req('/v1/messages', { body: { ...okBody, max_tokens: 8001 } }))).status).toBe(400);
  });
  it('beta 头不在白名单 → 400', async () => {
    const r = await call(req('/v1/messages', { headers: { 'x-api-key': 'tok-123', 'anthropic-beta': 'server-side-fallback-2026-07-01, fast-mode-2026-02-01' } }));
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('fast-mode-2026-02-01');
  });
  it('请求体不是 JSON → 400', async () => {
    expect((await call(req('/v1/messages', { body: '{oops' }))).status).toBe(400);
  });
  it('请求体太大 → 413', async () => {
    const big = { ...okBody, messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }] };
    expect((await call(req('/v1/messages', { body: big }))).status).toBe(413);
  });
  it('checkBody：fallbacks 数组形式（可指定任意模型）被拦，"default" 放行', () => {
    expect(checkBody({ ...okBody, fallbacks: [{ model: 'claude-fable-5-1' }] })).toMatch(/fallbacks/);
    expect(checkBody({ ...okBody, fallbacks: 'default' })).toBeNull();
  });
  it('checkBody：fast mode 被拦', () => {
    expect(checkBody({ ...okBody, speed: 'fast' })).toMatch(/fast/);
  });
  it('checkBody：边界', () => {
    expect(checkBody({ ...okBody, max_tokens: MAX_TOKENS })).toBeNull();
    expect(checkBody({ ...okBody, max_tokens: 0 })).not.toBeNull();
    expect(checkBody({ ...okBody, max_tokens: 1.5 })).not.toBeNull();
    expect(checkBody([])).not.toBeNull();
    for (const m of ALLOWED_MODELS) expect(checkBody({ ...okBody, model: m })).toBeNull();
  });
  it('badBetas', () => {
    expect(badBetas(null)).toEqual([]);
    expect(badBetas('server-side-fallback-2026-07-01')).toEqual([]);
    expect(badBetas('a, server-side-fallback-2026-07-01 ,b')).toEqual(['a', 'b']);
  });
});

describe('代理：转发', () => {
  it('换真 key、只转发白名单头、正文原样流式透传', async () => {
    const sse = 'event: message_start\ndata: {}\n\n';
    const f = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1', 'set-cookie': 'x=1' } }));
    vi.stubGlobal('fetch', f);

    const r = req('/v1/messages?beta=true', {
      headers: {
        authorization: 'Bearer tok-123',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        cookie: 'secret=1',
      },
      body: { ...okBody, stream: true, fallbacks: 'default', model: 'claude-sonnet-5-5' },
    });
    const res = await onRequest({ request: r, env });

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    const h = new Headers(init.headers);
    expect(h.get('x-api-key')).toBe('sk-real');
    expect(h.get('anthropic-version')).toBe('2026-10-21');
    expect(h.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01');
    expect(h.get('cookie')).toBeNull();
    expect(h.get('authorization')).toBeNull();
    expect(h.get('anthropic-dangerous-direct-browser-access')).toBeNull();
    expect(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)).model).toBe('claude-sonnet-5-5');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('request-id')).toBe('req_1');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(await res.text()).toBe(sse);
  });

  it('上游的错误状态码原样回传', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"type":"error"}', { status: 529, headers: { 'content-type': 'application/json' } })));
    expect((await call(req())).status).toBe(529);
  });
});
