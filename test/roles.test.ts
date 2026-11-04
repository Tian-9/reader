import { describe, expect, it } from 'vitest';
import { ALLOWED_BETAS, ALLOWED_MODELS, CHAT_MODEL_OPTIONS, FALLBACK_BETA, MAX_TOKENS_CAP, MODELS, REFUSAL_RETRY_MODEL, ROLES, checkBody, modelFor } from '../src/llm/roles';
import { baseParams, betaParams } from '../src/llm/client';
import type { Purpose } from '../src/types';

// 直连模式下没有代理把关了，白名单由 roles.ts 的 checkRequest 在浏览器里查（client.ts 的 guardedFetch）。
// 这里核对：业务代码会发出的每一种请求参数都过得了自己的白名单（不然上线就是一片 400）。
describe('roles 和请求白名单对得上', () => {
  it('模型清单一致', () => {
    expect([...ALLOWED_MODELS].sort()).toEqual([...MODELS].sort());
  });
  it('默认模型、聊天可选项、拒答重试模型都在白名单里', () => {
    for (const r of Object.values(ROLES)) expect(ALLOWED_MODELS.has(r.model)).toBe(true);
    for (const m of CHAT_MODEL_OPTIONS) expect(ALLOWED_MODELS.has(m.id)).toBe(true);
    expect(ALLOWED_MODELS.has(REFUSAL_RETRY_MODEL)).toBe(true);
  });
  it('max_tokens 不超上限', () => {
    expect(MAX_TOKENS_CAP).toBe(8000);
    for (const r of Object.values(ROLES)) expect(r.maxTokens).toBeLessThanOrEqual(MAX_TOKENS_CAP);
  });
  it('每个用途 × 每个可选模型的 baseParams / betaParams 都过 checkBody', () => {
    for (const purpose of Object.keys(ROLES) as Purpose[]) {
      for (const model of MODELS) {
        expect(checkBody({ ...baseParams(purpose, undefined, model), messages: [] })).toBeNull();
        const b = betaParams(purpose, undefined, model);
        expect(checkBody({ ...b, messages: [] })).toBeNull();
        for (const beta of ('betas' in b ? b.betas : [])) expect(ALLOWED_BETAS.has(beta)).toBe(true);
      }
    }
  });
  it('fallback 的 beta 头在白名单里', () => {
    expect(ALLOWED_BETAS.has(FALLBACK_BETA)).toBe(true);
  });
});

describe('modelFor', () => {
  it('没覆盖走默认', () => {
    expect(modelFor('chat')).toBe('claude-sonnet-5-5');
    expect(modelFor('annotate', { models: {} })).toBe('claude-haiku-5-5');
  });
  it('覆盖生效；不在白名单的覆盖被忽略', () => {
    expect(modelFor('chat', { models: { chat: 'claude-opus-5-5' } })).toBe('claude-opus-5-5');
    expect(modelFor('chat', { models: { chat: 'claude-fable-5-1' } })).toBe('claude-sonnet-5-5');
  });
});
