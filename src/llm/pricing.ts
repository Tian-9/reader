/**
 * 单价表（美元 / 百万 token），PLAN 第 6 节。和 roles.ts 的 MODELS 一一对应，test/pricing.test.ts 核对。
 *
 * - input：没命中缓存的输入
 * - output：输出 + 思考（思考 token 按输出计费，已经算在 usage.output_tokens 里）
 * - cacheRead：命中缓存的输入（约 1/10 或更低）
 * - cacheWrite：写缓存的输入。PLAN 没列，按 Anthropic 的规则取 5 分钟 TTL = 输入价 × 1.25
 *
 * Haiku 5.5 超过 10 万 token 的长提示词另有单价，我们每次只发 ≤900 词，用不到，不建模。
 */
import type { ModelId } from './roles';

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const p = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

export const PRICES: Record<ModelId, Price> = {
  'claude-haiku-5-5': p(0.1, 0.5, 0.01),
  'claude-sonnet-5-5': p(2, 10, 0.2),
  'claude-opus-5-5': p(4, 20, 0.2),
};

/** SDK usage 里我们用到的几个字段（缓存两项可能是 null）。 */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** 一次调用花了多少美元。不认识的模型按最贵的（Opus）算，宁可高估。 */
export function costUsd(model: string, u: UsageLike): number {
  const pr = PRICES[model as ModelId] ?? PRICES['claude-opus-5-5'];
  return (
    (u.input_tokens * pr.input +
      u.output_tokens * pr.output +
      (u.cache_read_input_tokens ?? 0) * pr.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * pr.cacheWrite) /
    1e6
  );
}
