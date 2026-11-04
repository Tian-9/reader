import { describe, expect, it } from 'vitest';
import { PRICES, costUsd } from '../src/llm/pricing';
import { MODELS } from '../src/llm/roles';

describe('价格表', () => {
  it('和 roles.ts 的模型一一对应，单价同 PLAN 第 6 节', () => {
    expect(Object.keys(PRICES).sort()).toEqual([...MODELS].sort());
    expect(PRICES['claude-haiku-5-5']).toMatchObject({ input: 0.1, output: 0.5, cacheRead: 0.01 });
    expect(PRICES['claude-sonnet-5-5']).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 });
    expect(PRICES['claude-opus-5-5']).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
  });
  it('缓存写入 = 输入 × 1.25；null 当 0', () => {
    expect(costUsd('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1e6, cache_read_input_tokens: null })).toBeCloseTo(2.5);
    expect(costUsd('claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(0.6);
  });
});
