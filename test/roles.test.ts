import { describe, expect, it } from 'vitest';
import { ALLOWED_BETAS, ALLOWED_MODELS, MAX_TOKENS } from '../functions/api/anthropic/[[path]]';
import { CHAT_MODEL_OPTIONS, FALLBACK_BETA, MAX_TOKENS_CAP, MODELS, REFUSAL_RETRY_MODEL, ROLES, modelFor } from '../src/llm/roles';

describe('roles 和代理白名单对得上', () => {
  it('模型清单一致', () => {
    expect([...ALLOWED_MODELS].sort()).toEqual([...MODELS].sort());
  });
  it('默认模型、聊天可选项、拒答重试模型都在白名单里', () => {
    for (const r of Object.values(ROLES)) expect(ALLOWED_MODELS.has(r.model)).toBe(true);
    for (const m of CHAT_MODEL_OPTIONS) expect(ALLOWED_MODELS.has(m.id)).toBe(true);
    expect(ALLOWED_MODELS.has(REFUSAL_RETRY_MODEL)).toBe(true);
  });
  it('max_tokens 不超代理上限', () => {
    expect(MAX_TOKENS_CAP).toBe(MAX_TOKENS);
    for (const r of Object.values(ROLES)) expect(r.maxTokens).toBeLessThanOrEqual(MAX_TOKENS);
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
