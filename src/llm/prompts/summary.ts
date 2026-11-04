/**
 * 章节前情摘要（PLAN 2.8：Haiku，纯文本，≤300 字；存 summaries 表，标注和聊天的 <story_so_far> 都用它）。
 *
 * 和 PLAN 第 6 节的估算不一样的地方：不是一次把整章发过去，而是按 T3 的分组（每组 ≤900 词左右）滚动摘要——
 * 每次发"到目前为止的摘要 + 下一组原文"，回来一份更新后的摘要。这样守住 PLAN 第 4 节"每次只发当前一小段（≤900 词）"。
 * 花费差不多（Haiku，一章 4–8 次，每次 ~1.5K 入 / ~300 出）。
 *
 * 用 structured outputs（{summary: string}）是为了复用 T3 的 callStructured（Haiku 被拒自动用 Sonnet 重试 + 记账）。
 * system 不到 512 token，达不到缓存下限，不打缓存断点。
 */

export const SUMMARY_PROMPT_VERSION = 1;
export const SUMMARY_MAX_CHARS = 300;

export const SUMMARY_SYSTEM = `你给一位读英文小说的中文读者写"前情提要"。她读完一章，你用中文把这一章发生了什么记下来，以后聊天和做小注时当背景用。

规则：
- 只写这一章里发生的事：谁、做了什么、关系和处境有什么变化。人名第一次出现时附英文原名，比如 温迪（Wendy）。
- 不超过 300 个汉字。平铺直叙，不评论、不抒情，不写"本章讲述了"这类套话。
- 不剧透：只根据给你的原文写，不提后面会发生什么，不说"这是伏笔"。
- 不抄原文：引用英文最多 5 个连续词，一般不需要引用。
- 原文是分几段陆续给你的。<summary_so_far> 是这一章前面部分你已经写好的摘要，把 <passage> 的新内容并进去，输出整章到目前为止的完整摘要（仍然 ≤300 字）。<earlier_chapters> 是前几章的摘要，只用来认人名，不要写进这一章的摘要。

只按给定的 JSON schema 输出。`;

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
} as const;

export function buildSummaryUser(x: {
  chapterTitle: string;
  earlier: string;
  soFar: string;
  paras: { id: string; text: string }[];
}): string {
  return [
    `<chapter>${x.chapterTitle}</chapter>`,
    `<earlier_chapters>${x.earlier}</earlier_chapters>`,
    `<summary_so_far>${x.soFar}</summary_so_far>`,
    '<passage>',
    x.paras.map((p) => p.text.replace(/\s*\n\s*/g, ' ')).join('\n'),
    '</passage>',
  ].join('\n');
}
