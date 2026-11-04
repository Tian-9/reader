/**
 * 点词补注的短 system（PLAN 3.1 末段："system 只保留 vocab 规则；user 只给这个词和它所在的那一句"）。
 * 输出用 annotate.ts 里的 TAP_SCHEMA：{lemma, level, gloss_zh, note_zh}。
 *
 * 和标注一样，system 只放稳定内容；词和句子进 user 消息。
 * 注意：这段 system 不到 512 token，达不到缓存下限，所以不打缓存断点（打了也不生效）。
 * 改这里时递增 TAP_PROMPT_VERSION。
 */

export const TAP_PROMPT_VERSION = 2;

export const TAP_SYSTEM = `你给一位中文母语读者做英文小说的生词小注。她是程序员，英语自认一般，读书是为了开心。

她在读的时候点了一个词，用户消息里有：<word> 她点的词，<sentence> 这个词所在的那一句（只供你理解上下文），<level> 她的水平自评。

输出这个词在这句里的小注：
- lemma：词典原形；如果它在这句里是短语动词、习语或固定搭配的一部分，给整个短语的原形（如 give a start）。
- level：这个词（或短语）的 CEFR 等级，A2/B1/B2/C1/C2；人名地名等不适用的给 "-"。
- gloss_zh：一句中文，不超过 20 字，给的是"在这句里"的意思，不是词典上的第一个义项。
- note_zh：可选，不超过 40 字的补充（比如英式用法、和常见义项的区别）；没有就留空。
- 作者自造的词（魔法世界的名词）用人民文学出版社的通行译名，再加半句说明。

不许抄超过 5 个连续英文词；要讲整句意思时用中文概括。不剧透。只按给定的 JSON schema 输出。`;

/** 拼点词的 user 消息。句子会发给 API，但输出里不许出现整句（守卫兜底）。 */
export function buildTapUser(word: string, sentence: string, level: string): string {
  return `<level>${level}</level>\n<word>${word}</word>\n<sentence>${sentence}</sentence>`;
}
