import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANNOTATE_SCHEMA, ANNOTATE_SYSTEM, TAP_SCHEMA } from '../src/llm/prompts/annotate';
import { CHAT_SYSTEM } from '../src/llm/prompts/chat';

type Obj = { type: string; additionalProperties: boolean; required: readonly string[]; properties: Record<string, unknown> };

/** structured outputs 的硬要求：每层 object 都 additionalProperties: false，required 覆盖全部字段。 */
function strictShape(o: Obj) {
  expect(o.type).toBe('object');
  expect(o.additionalProperties).toBe(false);
  expect([...o.required].sort()).toEqual(Object.keys(o.properties).sort());
}

describe('标注 schema', () => {
  it('外层和条目都是严格对象', () => {
    strictShape(ANNOTATE_SCHEMA as unknown as Obj);
    strictShape(ANNOTATE_SCHEMA.properties.items.items as unknown as Obj);
    strictShape(TAP_SCHEMA as unknown as Obj);
  });

  it('system 里的例子输出符合 schema 的枚举，且 quote 不超过 5 词、逐字出自例段', () => {
    const passage = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(ANNOTATE_SYSTEM)![1]!;
    const paras = new Map(passage.split('\n').map((l) => [l.slice(1, 9), l.slice(11)]));
    const json = /期望输出[^\n]*\n([\s\S]*?)\n<\/example>/.exec(ANNOTATE_SYSTEM)![1]!;
    const { items } = JSON.parse(json) as { items: Record<string, unknown>[] };
    const p = ANNOTATE_SCHEMA.properties.items.items.properties;
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(Object.keys(it).sort()).toEqual([...ANNOTATE_SCHEMA.properties.items.items.required].sort());
      expect(p.kind.enum).toContain(it.kind);
      expect(p.level.enum).toContain(it.level);
      expect(p.fun_type.enum).toContain(it.fun_type);
      const quote = it.quote as string;
      expect(quote.split(/\s+/).length).toBeLessThanOrEqual(5);
      expect(paras.get(it.p as string)).toContain(quote);
    }
  });

  it('system 里没有易变内容的占位（缓存前缀必须稳定）', () => {
    for (const s of [ANNOTATE_SYSTEM, CHAT_SYSTEM]) expect(s).not.toMatch(/\$\{|\{\{|Date|今天是/);
  });
});

describe('prompt 和 PLAN 逐字一致', () => {
  // PLAN.md 是定稿，改 prompt 先改文档：3.1 的 system 代码块 = ANNOTATE_SYSTEM，3.2 的代码块 = CHAT_SYSTEM
  const plan = readFileSync(new URL('../PLAN.md', import.meta.url), 'utf8');
  const fenceAfter = (marker: string) => {
    const i = plan.indexOf(marker);
    expect(i).toBeGreaterThan(-1);
    return /```\n([\s\S]*?)\n```/.exec(plan.slice(i))![1]!;
  };

  it('3.1 标注 system', () => {
    expect(ANNOTATE_SYSTEM).toBe(fenceAfter('**system（稳定，打缓存）**'));
  });

  it('3.2 小克 system', () => {
    expect(CHAT_SYSTEM).toBe(fenceAfter('### 3.2 聊天 system prompt'));
  });

  it('PLAN 2.4 的 fun_type 枚举和 schema 一致', () => {
    const m = /"fun_type": \{ "type": "string", "enum": (\[[^\]]*\]) \}/.exec(plan)!;
    expect(JSON.parse(m[1]!)).toEqual(ANNOTATE_SCHEMA.properties.items.items.properties.fun_type.enum);
  });
});
