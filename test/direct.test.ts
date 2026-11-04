// 直连模式（PLAN 2.6）：原代理的白名单现在在浏览器里把关（roles.ts 的 checkRequest，client.ts 的 guardedFetch）。
// 用例从 legacy/proxy.test.ts 的"只开 POST /v1/messages""限额"两组搬过来，再加上直连本身：地址、浏览器直连头、key 怎么带。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, LOCAL_BLOCK_PREFIX, NoKeyError, getClient, guardedFetch, ping } from '../src/llm/client';
import { ALLOWED_MODELS, MAX_TOKENS_CAP, badBetas, checkBody, checkRequest } from '../src/llm/roles';

const URL_MSG = `${API_BASE}/v1/messages`;
const okBody = { model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
const r = (over: Partial<Parameters<typeof checkRequest>[0]> = {}) =>
  checkRequest({ method: 'POST', url: URL_MSG, beta: null, body: JSON.stringify(okBody), ...over });

afterEach(() => vi.unstubAllGlobals());

describe('checkRequest：只开 POST /v1/messages', () => {
  it('合法请求放行；?beta=true 放行', () => {
    expect(r()).toBeNull();
    expect(r({ url: `${URL_MSG}?beta=true` })).toBeNull();
  });
  it('别的路径 → 404；GET → 405；别的查询参数 → 400', () => {
    expect(r({ url: `${URL_MSG}/count_tokens` })?.status).toBe(404);
    expect(r({ url: `${API_BASE}/v1/models`, method: 'GET', body: null })?.status).toBe(404);
    expect(r({ method: 'GET' })?.status).toBe(405);
    expect(r({ url: `${URL_MSG}?foo=1` })?.status).toBe(400);
  });
});

describe('checkRequest：限额', () => {
  it('模型不在白名单 → 400，报出模型名', () => {
    const x = r({ body: JSON.stringify({ ...okBody, model: 'claude-fable-5-1' }) });
    expect(x?.status).toBe(400);
    expect(x?.message).toContain('claude-fable-5-1');
  });
  it('max_tokens 超上限 → 400', () => {
    expect(r({ body: JSON.stringify({ ...okBody, max_tokens: MAX_TOKENS_CAP + 1 }) })?.status).toBe(400);
  });
  it('beta 头不在白名单 → 400', () => {
    const x = r({ beta: 'server-side-fallback-2026-07-01, fast-mode-2026-02-01' });
    expect(x?.status).toBe(400);
    expect(x?.message).toContain('fast-mode-2026-02-01');
  });
  it('请求体不是 JSON / 不是字符串 → 400；太大 → 413', () => {
    expect(r({ body: '{oops' })?.status).toBe(400);
    expect(r({ body: null })?.status).toBe(400);
    const big = { ...okBody, messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }] };
    expect(r({ body: JSON.stringify(big) })?.status).toBe(413);
  });
  it('checkBody：fallbacks 数组形式（可指定任意模型）被拦，"default" 放行；fast mode 被拦', () => {
    expect(checkBody({ ...okBody, fallbacks: [{ model: 'claude-fable-5-1' }] })).toMatch(/fallbacks/);
    expect(checkBody({ ...okBody, fallbacks: 'default' })).toBeNull();
    expect(checkBody({ ...okBody, speed: 'fast' })).toMatch(/fast/);
  });
  it('checkBody：边界', () => {
    expect(checkBody({ ...okBody, max_tokens: MAX_TOKENS_CAP })).toBeNull();
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

describe('guardedFetch', () => {
  it('不过白名单：本地回 Anthropic 格式的错误，请求不出浏览器', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const res = await guardedFetch(URL_MSG, { method: 'POST', body: JSON.stringify({ ...okBody, model: 'claude-fable-5-1' }) });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.type).toBe('error');
    expect(j.error.message.startsWith(LOCAL_BLOCK_PREFIX)).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
  it('过了就原样交给 fetch', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    const init = { method: 'POST', body: JSON.stringify(okBody), headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } };
    expect((await guardedFetch(URL_MSG, init)).status).toBe(200);
    expect(f).toHaveBeenCalledWith(URL_MSG, init);
  });
});

function fakeMessage(model: string) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: '好', citations: null }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

describe('直连客户端（真 SDK，fetch 打桩）', () => {
  it('没填 key → NoKeyError；ping 说"去设置页填"', async () => {
    await expect(getClient('  ')).rejects.toBeInstanceOf(NoKeyError);
    expect(await ping('')).toMatchObject({ ok: false, message: expect.stringContaining('API key') });
  });

  it('打 api.anthropic.com/v1/messages，带浏览器直连头，key 在请求头里', async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      new Response(JSON.stringify(fakeMessage('claude-haiku-5-5')), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    expect(await ping('test-key-1')).toEqual({ ok: true, model: 'claude-haiku-5-5' });
    expect(f).toHaveBeenCalledOnce();
    const [u, init] = f.mock.calls[0]!;
    expect(String(u)).toBe(URL_MSG);
    const h = new Headers(init!.headers);
    expect(h.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    // SDK 1.x 用 Authorization: Bearer 带 key（0.x 是 x-api-key），两种 Anthropic 都认
    expect(h.get('x-api-key') ?? h.get('authorization')).toContain('test-key-1');
  });

  it('白名单外的请求被本地拦成 APIError(400)，不发网络', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const c = await getClient('test-key-2');
    await expect(c.messages.create({ ...okBody, model: 'claude-fable-5-1', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 400 });
    await expect(c.messages.create({ ...okBody, max_tokens: 9000, messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 400 });
    expect(f).not.toHaveBeenCalled();
  });

  it('401 → ping 说 key 不对', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } })));
    expect(await ping('test-key-bad')).toMatchObject({ ok: false, status: 401, message: expect.stringContaining('key 不对') });
  });
});
