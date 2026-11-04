/**
 * 标注 prompt（PLAN 3.1，原样落地）。T3 直接用：
 *   system  = [{ type: 'text', text: ANNOTATE_SYSTEM, cache_control: { type: 'ephemeral' } }]   // 稳定前缀，打缓存断点
 *   user    = 按 ANNOTATE_USER_TEMPLATE 的形状拼 <reader_profile> → <story_so_far> → <already_noted> → <passage>
 *   output_config.format = { type: 'json_schema', schema: ANNOTATE_SCHEMA }
 *
 * 改 prompt 或 schema 时递增 ANNOTATE_PROMPT_VERSION（chunks 表按它判断要不要重标）。
 * 字数上限（gloss ≤20 字、note ≤60 字、quote ≤5 词）写在 prompt 里，由客户端校验，不靠 schema 关键字。
 */

export const ANNOTATE_PROMPT_VERSION = 1;

/** system：规则 + 自编例段。不许往里塞任何易变内容（时间、当前段落），否则缓存全废。 */
export const ANNOTATE_SYSTEM = `你给一位中文母语读者做英文小说的"边读边看"小注。她住在都柏林，是程序员，英语自认一般，读书是为了开心，不是来上课的。读者资料和正文在用户消息里。

读 <passage> 里的段落（每段开头的 [c03p0012] 是段落编号），挑两类东西：

1. vocab：她可能不认识的词或短语（含短语动词、习语、固定搭配）
   - 只挑等级 ≥ <reader_profile> 里"标注下限"的。
   - <known> 里的词（包括它们的各种变形）一律不标；<unknown> 里的词遇到就标。
   - 同一个 lemma 在本次只标第一次出现；<already_noted> 里的不再标，除非这里是不同的意思。
   - gloss_zh：一句中文，不超过 20 字，给的是"在这句里"的意思，不是词典上的第一个义项。
   - 作者自造的词（魔法世界的名词）invented=true，gloss_zh 用人民文学出版社的通行译名，再加半句说明。
   - 人名、地名一般不标，除非名字本身是个梗。

2. fun：值得停下来品一下的地方：双关、英式说法、方言口音、作者的反讽和阴阳怪气、英国文化梗（学校制度、中产生活、食物、钱）。
   - note_zh 不超过 60 字：先用大白话讲清楚，可以再跟一句俏皮话。
   - 如果这个说法在爱尔兰也常听到，或者恰好相反，顺口提一句。
   - 宁缺毋滥：每次 0 到 4 条，没有就不写。

锚定规则（最重要）：
- quote 必须从该段原文逐字照抄，连续 1 到 5 个英文词，能定位就行，越短越好。
- occ 是这个 quote 在该段里第几次出现，从 1 开始数。
- 任何字段都不许抄超过 5 个连续英文词。需要讲整句意思时，用中文概括。

不剧透：你只知道 <story_so_far> 和本次段落里的内容。不说"这是伏笔""后面会……"，也不暗示人物以后会怎样。

只按给定的 JSON schema 输出。

<example>
<passage>
[x01p0001] Mrs Pell was the sort of neighbour who noticed everything and approved of nothing. She had counted the milk bottles on the Quinns' step twice that morning, which, as her husband pointed out, was once more than strictly necessary.
[x01p0002] "Lovely weather," said Mr Quinn, as the rain came down sideways.
</passage>
期望输出（读者 B1，标注下限 A2→只显示 B2 以上）：
{"items":[
 {"kind":"vocab","p":"x01p0001","quote":"approved of","occ":1,"lemma":"approve of","level":"B1","invented":false,"fun_type":"-","gloss_zh":"看得上、认可","note_zh":""},
 {"kind":"fun","p":"x01p0001","quote":"approved of nothing","occ":1,"lemma":"","level":"-","invented":false,"fun_type":"作者幽默","gloss_zh":"","note_zh":"啥都看见、啥都看不惯，一句话给邻居定了性。英国小说爱用这种前后一扬一抑的句式。"},
 {"kind":"fun","p":"x01p0001","quote":"once more than strictly necessary","occ":1,"lemma":"","level":"-","invented":false,"fun_type":"反讽","gloss_zh":"","note_zh":"丈夫的意思是\\"数一遍都多余\\"，故意说得很客气，其实是在损她。"},
 {"kind":"fun","p":"x01p0002","quote":"Lovely weather","occ":1,"lemma":"","level":"-","invented":false,"fun_type":"英式表达","gloss_zh":"","note_zh":"下着横飞的雨说\\"天气真好\\"，典型英式反话。都柏林人也天天这么说。"},
 {"kind":"vocab","p":"x01p0002","quote":"sideways","occ":1,"lemma":"sideways","level":"B2","invented":false,"fun_type":"-","gloss_zh":"横着、斜着（雨被风吹横了）","note_zh":""}
]}
</example>`;

/**
 * user 消息的形状示意（PLAN 原稿，括号里是说明，不是要发出去的字）。T3 写真正的拼装函数时照这个顺序：
 * 变化越少的越往前。
 */
export const ANNOTATE_USER_TEMPLATE = `<reader_profile>
水平自评：B1；标注下限：A2
<known>（最近 60 个标为"认识"的词，优先选接近阈值的）cupboard, stare, mutter, …</known>
<unknown>（最近 40 个点过或标为"不认识"的词）gibber, rummage, …</unknown>
</reader_profile>
<story_so_far>（前几章的中文摘要，≤600 字）</story_so_far>
<already_noted>（本章已经标过的 lemma）…</already_noted>
<passage>
[c03p0012] ……
[c03p0013] ……
</passage>`;

/** structured outputs 用的 JSON schema（PLAN 2.4(a)）。所有字段必填，不需要的填空字符串或 "-"。 */
export const ANNOTATE_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "items"
  ],
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "p",
          "quote",
          "occ",
          "lemma",
          "level",
          "invented",
          "fun_type",
          "gloss_zh",
          "note_zh"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "vocab",
              "fun"
            ]
          },
          "p": {
            "type": "string",
            "description": "段落编号，如 c03p0012"
          },
          "quote": {
            "type": "string",
            "description": "从该段逐字照抄的连续 1-5 个英文词"
          },
          "occ": {
            "type": "integer",
            "description": "quote 在该段第几次出现，从 1 开始"
          },
          "lemma": {
            "type": "string",
            "description": "vocab: 词典原形或短语原形，如 give a start；fun: 空字符串"
          },
          "level": {
            "type": "string",
            "enum": [
              "A2",
              "B1",
              "B2",
              "C1",
              "C2",
              "-"
            ]
          },
          "invented": {
            "type": "boolean",
            "description": "作者自造词，如 Muggle"
          },
          "fun_type": {
            "type": "string",
            "enum": [
              "-",
              "双关",
              "英式表达",
              "爱尔兰/方言",
              "反讽",
              "文化梗",
              "作者幽默"
            ]
          },
          "gloss_zh": {
            "type": "string",
            "description": "vocab: 一句中文，≤20 字，取这句里的意思；fun: 空字符串"
          },
          "note_zh": {
            "type": "string",
            "description": "fun: ≤60 字的中文讲解；vocab: 可选的补充说明，没有就留空"
          }
        }
      }
    }
  }
} as const;

/**
 * 点词补注的输出 schema。PLAN 3.1 末段只给了字段 {lemma, level, gloss_zh, note_zh}，这里按同样的约定补成 schema；
 * 点词的 system（"只保留 vocab 规则"的短版本）PLAN 没出全文，留给 T3 写。
 */
export const TAP_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "lemma",
    "level",
    "gloss_zh",
    "note_zh"
  ],
  "properties": {
    "lemma": {
      "type": "string",
      "description": "vocab: 词典原形或短语原形，如 give a start；fun: 空字符串"
    },
    "level": {
      "type": "string",
      "enum": [
        "A2",
        "B1",
        "B2",
        "C1",
        "C2",
        "-"
      ]
    },
    "gloss_zh": {
      "type": "string",
      "description": "vocab: 一句中文，≤20 字，取这句里的意思；fun: 空字符串"
    },
    "note_zh": {
      "type": "string",
      "description": "fun: ≤60 字的中文讲解；vocab: 可选的补充说明，没有就留空"
    }
  }
} as const;
