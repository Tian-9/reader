# 英语阅读器 · 方案（PLAN.md）

> 给剧组和她本人看。术语第一次出现时带一句大白话解释。
> 价格数据取自 Claude API 官方价目（2026-10 缓存）以及 pocketverse 的 `pricing.ts`，两边一致。
> 2026-11-04 方案剧组出稿，总台存档并在第 7 节补了已拍板项。

## 0. 一句话

**第一个能用的版本**：在手机上打开她自己的《哈利波特与魔法石》EPUB 顺着读，生词和有意思的句子被自动划出来，点开有一句中文小注；点"这个我会"它就不再标；读到卡壳就拉出小克聊两句。

（HP1 文件到位前，用 books/ 里的公版书《彼得潘》《绿野仙踪》开发和验收。）

---

## 1. MVP 范围

### 必做
| # | 功能 | 说明 |
|---|---|---|
| 1 | 导入 EPUB | 用手机的文件选择器导入，**书只存在手机本地**。带 DRM（数字版权锁，加密过的电子书，没有钥匙打不开）的文件直接拒绝并给出提示。 |
| 2 | 阅读视图 | 竖向滚动，按段落排版，记住读到哪一段，重开后回到原位。导入之后断网也能读。 |
| 3 | 自动标注 | 两种标注：①**生词小注**（中文，一句话，取这句里的意思）②**这句有意思**（双关、英式/爱尔兰说法、反讽、文化梗）。提前把后面一两屏标好，翻到那里不用等。 |
| 4 | 她的词库 | 每个词三种状态：认识 / 在学 / 不认识。点"这个我会"后，全书同一个词立刻不再标。点任意没标的词会现场补一条注。 |
| 5 | 小克抽屉 | 从底部拉出的聊天面板。上下文 = 屏幕上正在看的段落 + 最近点过的词 + 前情摘要。默认中文，可切英文。流式输出（字一个个蹦出来，不用等整段生成完）。 |
| 6 | 前情摘要 | 每读完一章，用 Haiku 写一段 ≤300 字的中文摘要，存在本地。聊天和标注都会用到。 |
| 7 | 代理 + 部署 | API key 只放在服务器端，手机上只存一个"应用口令"。 |
| 8 | 生词导出 | 导出成和背单词页同形状的 JSON 文件。 |
| 9 | 花费小账本 | 显示"这本书已经花了 $x.xx"。她本来就想花掉额度，看着数字涨也算个乐趣。 |

### 不做（MVP 之后再说）
- 多设备同步（词库先只在本机，靠 JSON 备份兜底）
- 多本书的书架界面（数据结构支持多本，界面上只做一本）
- App 内的复习/背单词功能（交给已有的背单词页）
- 朗读、发音音频
- 翻页动画、横屏/桌面端精修
- 首次使用的词汇水平测试（MVP 用一个"水平自评"下拉框，后面让词库自己校准）
- EPUB 里的插图、原书排版样式
- 英文界面（UI 只做中文；聊天可以切英文）
- 账号体系

---

## 2. 架构

### 2.1 总体

```
手机 PWA（Cloudflare Pages 上的静态文件）
 ├─ EPUB 解析 → 段落 → IndexedDB（书、标注、词库、聊天、账本全在本地）
 ├─ 阅读视图 + 标注层 + 小克抽屉
 └─ Anthropic SDK（baseURL = 同站 /api/anthropic，key = 应用口令）
          │  只发：当前这一小段正文 + 词库样本 + 摘要
          ▼
Cloudflare Pages Function（/api/anthropic/*）
 ├─ 校验应用口令 → 换成真 API key
 ├─ 模型白名单、max_tokens 上限、beta 头白名单
 └─ 原样转发到 api.anthropic.com，流式透传，不记录请求正文
```

**PWA**：一种"网页做的 App"，加到手机主屏幕后像原生 App 一样全屏打开，可以离线用。
**Cloudflare Pages / Pages Functions**：Pages 托管静态网页；Functions 是挂在同一个网站下的小段服务器代码（底层就是 Cloudflare Worker）。她的 yingai.me 已经在用这套，部署命令一样。

### 2.2 前端：Vite + TypeScript + Svelte 5

| 选项 | 结论 | 理由 |
|---|---|---|
| 纯 HTML/JS 单文件（porcelain 那种） | 不选 | porcelain 是"一个画布 + 一排滑块"，状态很少。阅读器要同时管阅读视图、标注卡片、抽屉、词库、导入流程，状态多。没有框架的话手写 DOM 同步会越写越乱。 |
| Svelte 5（pocketverse 用的） | **选** | 打包小、写法接近 HTML。pocketverse 的 CLAUDE.md 已经记下一批坑（比如 `$state` 对象存进 Dexie 前要先 `$state.snapshot`），剧组可以直接避开。 |
| TypeScript | **选** | 标注数据结构是整个项目的核心，有类型约束能少出错。她是 C# 程序员，读带类型的代码也顺手。 |
| Tailwind | 不选 | 阅读器的重点是排版（字号、行距、段距），手写 CSS 变量更好控制。 |
| pocketverse 的插件内核 | 不选 | 这里没有插件需求，照搬只会增加复杂度。 |

- **Vite**：前端打包工具，把源码打成手机能直接加载的文件。
- **vite-plugin-pwa**：自动生成 PWA 需要的 manifest（应用名、图标）和 service worker（负责离线缓存的后台脚本）。
- **Dexie**：IndexedDB 的易用封装。**IndexedDB** 是浏览器自带的本地数据库，容量足够放一整本书。

### 2.3 EPUB 解析：fflate + 浏览器自带的 DOMParser，自己拆段落

EPUB 本质上是一个 zip 包，里面装着若干 XHTML 网页、一份目录（OPF/NAV）和一份阅读顺序（spine）。

| 方案 | 结论 | 理由 |
|---|---|---|
| epub.js | 不选 | 用 iframe（页面里嵌的独立小页面）渲染，标注层很难叠上去；位置用 CFI（EPUB 专用的位置编码）表示，锚定麻烦；维护也不活跃。 |
| foliate-js | 不选 | 比 epub.js 新，渲染质量好，但同样是它自己控制渲染，我们要在文字上划线、点词就得和它的分页器较劲。 |
| **fflate 解压 + DOMParser 拆段落** | **选** | HP1 是纯文字小说，不需要还原原书排版。自己拆成"章 → 段"之后，每段的文字和编号都由我们掌握，锚定、点词、记进度都简单。fflate 只有约 8KB。 |

**拆段规则**：按 spine 顺序读每个 XHTML，取 `<p>`（以及标题），文字做 NFC 规范化（把同一个字符的不同编码统一成一种），保留弯引号。段落编号格式为 `c03p0012`（第 3 章第 12 段）。章节标题从 NAV/NCX 目录里取。Gutenberg 书的 spine 首项（封面壳，0 词）和末项（license）要跳过（见 books/README.md）。

**DRM 检测**：
- 有 `META-INF/encryption.xml`，并且被加密的文件里包含 .xhtml/.html → 拒绝。只加密字体（算法是 `http://www.idpf.org/2008/embedding` 或 `http://ns.adobe.com/pdf/enc#RC`）不算 DRM，放行。
- 有 `META-INF/rights.xml`（Adobe DRM）或 `sinf.xml`（Apple DRM）→ 拒绝。
- 兜底：解析出的正文是乱码，或者段落数少于 50 → 提示"这本可能加密了"。
- 提示语："这本书带版权锁，阅读器打不开。用你自己买的无 DRM 版本就行（官方 Wizarding World/Pottermore 卖的通常只有水印，没有锁）。"

**共享接口**（T1 先定下来，让 T2 和 T3 可以并行开发）：
```ts
interface Para { id: string; chapter: number; idx: number; text: string }   // id = "c03p0012"
interface Chapter { n: number; title: string; paraIds: string[] }
```

### 2.4 标注数据结构

#### (a) 模型输出（用 structured outputs 强制按 JSON schema 返回）
**structured outputs**：API 的一个功能，强制模型按我们给的 JSON 格式输出，不会多出闲话，也不会出现括号没闭合之类的格式错误。

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["items"],
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "p", "quote", "occ", "lemma", "level", "invented", "fun_type", "gloss_zh", "note_zh"],
        "properties": {
          "kind":     { "type": "string", "enum": ["vocab", "fun"] },
          "p":        { "type": "string", "description": "段落编号，如 c03p0012" },
          "quote":    { "type": "string", "description": "从该段逐字照抄的连续 1-5 个英文词" },
          "occ":      { "type": "integer", "description": "quote 在该段第几次出现，从 1 开始" },
          "lemma":    { "type": "string", "description": "vocab: 词典原形或短语原形，如 give a start；fun: 空字符串" },
          "level":    { "type": "string", "enum": ["A2", "B1", "B2", "C1", "C2", "-"] },
          "invented": { "type": "boolean", "description": "作者自造词，如 Muggle" },
          "fun_type": { "type": "string", "enum": ["-", "双关", "英式表达", "爱尔兰/方言", "反讽", "文化梗", "作者幽默"] },
          "gloss_zh": { "type": "string", "description": "vocab: 一句中文，≤20 字，取这句里的意思；fun: 空字符串" },
          "note_zh":  { "type": "string", "description": "fun: ≤60 字的中文讲解；vocab: 可选的补充说明，没有就留空" }
        }
      }
    }
  }
}
```
- **lemma**：词的"原形"。went 的 lemma 是 go。词库按 lemma 记，这样认识 go 就等于认识 went。
- **level** 用 **CEFR** 分级（欧洲语言能力等级，A1 最简单，C2 最难；B1 大约是"能读简单小说"）。
- 字数上限、≤5 词这些约束写在 prompt 里，由客户端校验，不依赖 schema 的长度关键字。
- 所有字段都设为必填，不需要的字段填空字符串或 `"-"`，这样 schema 简单，模型不容易出错。

#### (b) 本地存储（Dexie 表）
```ts
books       { id /*文件 sha256*/, title, author, addedAt }
paras       { [bookId+id], chapter, idx, text }
chunks      { [bookId+chunkId], paraIds, status: 'todo'|'done'|'error', model, promptVersion, levelFloor }
annotations { id, bookId, chunkId, paraId, kind, quote, start, end, lemma, level, invented,
              funType, glossZh, noteZh, model, createdAt }
words       { lemma, status: 'known'|'learning'|'unknown', source: 'dismissed'|'tapped'|'self-rated',
              glossZh, firstSeen: {bookId, paraId}, taps, updatedAt }
progress    { bookId, paraId, updatedAt }
summaries   { [bookId+chapter], textZh, model }
chats       { id, bookId, lang: 'zh'|'en', messages, createdAt }
ledger      { ts, purpose: 'annotate'|'tap'|'summary'|'chat', model, input, output, cacheRead, cacheWrite, usd }
```

#### (c) 锚定（把标注准确对到原文上的那几个字）
- 模型只给"段落编号 + 短引文 + 第几次出现"。**字符偏移**（这几个字从段落第几个字符开始）由客户端算出来再存。原因是大模型数字符位置很不靠谱，抄几个词却很准。
- 匹配前，两边都做规范化：弯引号统一成直引号，连续空格合成一个，大小写不敏感。匹配上之后再映射回原文位置。
- 找不到、或者超过 5 个词的条目直接丢弃，并计入"锚定失败率"指标。

#### (d) "越读越准"的机制
- 每次调用时，告诉模型她的"标注下限" = 她的水平往下一档（比如她是 B1，就标 A2 以上的）。这样 AI 返回的范围略宽一些。
- **显示时由客户端过滤**：只显示等级高于她当前阈值、且 lemma 不在"认识"集合里的条目。点"这个我会"会立刻生效，不需要重新调 API。
- 阈值自动微调：她在某个等级上连续点"这个我会"超过 N 次（比如 B2 连点 15 次）→ 提示"要不要把阈值调到 C1？"。只提示，不自动改。
- 下一次调用时，会带上最近标为认识/不认识的词样本，让模型的判断跟着她的实际情况走。

### 2.5 词库存储：只存本地 IndexedDB，暂不同步

| 方案 | 结论 | 理由 |
|---|---|---|
| **本地 IndexedDB** | **选** | 零服务器、零隐私风险、离线可用。她现在只在一台手机上读。 |
| 云同步（Cloudflare D1/KV） | 以后再做 | 只同步词库，书永远不同步。等她真有第二台设备的需求再说。 |

两个兜底：
- 启动时调用 `navigator.storage.persist()`，向浏览器申请"别自动清掉我的数据"。**一定要加到主屏幕再用。**
- 设置页提供"导出/导入词库 JSON"。

### 2.6 代理层（API key 不进前端）

前端照常用官方 `@anthropic-ai/sdk`，只是把地址指到自家网站上：
```ts
new Anthropic({ baseURL: `${location.origin}/api/anthropic`, apiKey: appToken, dangerouslyAllowBrowser: true })
```
这里的 `apiKey` 只是"应用口令"，不是真 key。Pages Function（约 60 行）做这几件事：
1. `x-api-key` 和环境变量 `APP_TOKEN` 不一致 → 返回 401。
2. 只允许 `POST /v1/messages`。
3. `model` 必须在白名单 `{claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5}` 里，`max_tokens` 不超过 8000，`anthropic-beta` 头只放行用到的几个。
4. 把口令换成真 key `ANTHROPIC_API_KEY`（用 `wrangler pages secret put` 设置，**这一步她自己敲**），转发到 `https://api.anthropic.com`，响应体原样流式返回。**SSE**（服务器一边生成一边推送的格式）不能先缓存再发，否则就没有流式效果了。
5. **不打印、不存储请求正文**，只能记录 usage 数字。

这样设计的理由：SDK 自带流式、重试和类型，前端不用手写 HTTP；代理只做"认人 + 换钥匙 + 限额"，薄到一眼能看完。再在 Anthropic 控制台给这个 key 所在的 workspace 设一个月度花费上限，即使口令泄露，损失也有上限。

**为什么不用 Cloudflare Access 挡在整个网站前面**：PWA 在主屏幕全屏模式下走 Access 的登录跳转很容易出问题。应用口令只需要在设置里输入一次，已经够用。

### 2.7 部署

- Cloudflare Pages 新建项目 `reader`，构建产物是 `dist/`，Functions 放在 `functions/api/anthropic/[[path]].ts`。
- 部署命令照 yingai 的做法：`npm run build && ~/node_modules/.bin/wrangler pages deploy dist --project-name reader --branch main`
- `public/_headers` 里写 CSP（内容安全策略，浏览器层面的白名单，规定页面只能连哪些地址）：
  `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'`
- 不用任何 CDN 字体、统计脚本或第三方 SDK。

### 2.8 模型调用参数

| 用途 | 模型 | 参数 |
|---|---|---|
| 标注 | `claude-haiku-5-5` | structured outputs；`thinking: {type: "adaptive"}`，effort `medium`（默认值）。成本反正很低，先求质量，等 T3 的样本评测结果出来再决定要不要降。 |
| 点词补注 | `claude-haiku-5-5` | 同上，max_tokens 400 |
| 章节摘要 | `claude-haiku-5-5` | 纯文本，≤300 字 |
| 聊天 | 默认 `claude-sonnet-5-5`，设置里可切 `claude-opus-5-5` | 流式；adaptive thinking，effort `medium`；加 `fallbacks: "default"`（beta 头 `server-side-fallback-2026-07-01`），这样万一被安全分类器误拒，会自动换个模型重试 |

- 模型名不要写死在业务代码里，统一在 `llm/roles.ts` 里按用途配置（借 pocketverse 的思路）。设置页可以改，比如"标注改用 Sonnet"。
- Haiku 5.5 被拒绝时没有服务器端兜底，所以客户端遇到 `stop_reason: "refusal"` 时自动用 Sonnet 重试一次。

### 2.9 Prompt caching 怎么摆

**Prompt caching**（提示词缓存）：如果每次请求的开头部分完全一样，API 会把这部分记住，下次只收约 1/10 的钱，速度也更快。前提是前缀一个字节都不能变。Haiku/Sonnet/Opus 5.5 的最低可缓存长度是 512 token（token 约等于 3/4 个英文单词）。

- **标注**：`system` = 规则 + 自编例段（稳定，打缓存断点）→ user 消息依次放 `reader_profile` → `story_so_far` → `passage`。变化越少的越往前放。
- **聊天**：`system` = 小克人格（稳定，断点 1）→ 第一条 user 消息 = 前情摘要（每章才变一次，断点 2）→ 对话历史 → 最后一条 user 消息里放当前屏幕段落和最近点的词（每轮都变，所以放最后）→ 最后一条消息上打断点 3，让对话历史也能被缓存。
- 易变的内容（时间、当前段落）**只能放在最后一条 user 消息里**，绝对不能写进 system。这条是 pocketverse 踩过的坑。
- 验收方法：同一会话第二轮的 `usage.cache_read_input_tokens` 必须 > 0。

---

## 3. 两个 prompt 草案

### 3.1 标注 prompt

**system（稳定，打缓存）**
```
你给一位中文母语读者做英文小说的"边读边看"小注。她住在都柏林，是程序员，英语自认一般，读书是为了开心，不是来上课的。读者资料和正文在用户消息里。

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
 {"kind":"fun","p":"x01p0001","quote":"once more than strictly necessary","occ":1,"lemma":"","level":"-","invented":false,"fun_type":"反讽","gloss_zh":"","note_zh":"丈夫的意思是\"数一遍都多余\"，故意说得很客气，其实是在损她。"},
 {"kind":"fun","p":"x01p0002","quote":"Lovely weather","occ":1,"lemma":"","level":"-","invented":false,"fun_type":"英式表达","gloss_zh":"","note_zh":"下着横飞的雨说\"天气真好\"，典型英式反话。都柏林人也天天这么说。"},
 {"kind":"vocab","p":"x01p0002","quote":"sideways","occ":1,"lemma":"sideways","level":"B2","invented":false,"fun_type":"-","gloss_zh":"横着、斜着（雨被风吹横了）","note_zh":""}
]}
</example>
```
（注：第三条引文 "once more than strictly necessary" 是 5 个词，正好在上限。例段是我们自己编的，不是任何书的原文。）

**user（每次请求都变）**
```
<reader_profile>
水平自评：B1；标注下限：A2
<known>（最近 60 个标为"认识"的词，优先选接近阈值的）cupboard, stare, mutter, …</known>
<unknown>（最近 40 个点过或标为"不认识"的词）gibber, rummage, …</unknown>
</reader_profile>
<story_so_far>（前几章的中文摘要，≤600 字）</story_so_far>
<already_noted>（本章已经标过的 lemma）…</already_noted>
<passage>
[c03p0012] ……
[c03p0013] ……
</passage>
```
- 每次发的段落组（chunk）约 600–900 词，不在段落中间切开，chunk 编号用第一段的编号。
- 预取：她读到第 k 组时，确保第 k、k+1 组已标好，并在后台请求第 k+2 组。

**点词补注**用一个更短的变体：system 只保留 vocab 规则；user 消息只给这个词和它所在的那一句（这一句会发给 API，但输出里不许出现整句）；输出 `{lemma, level, gloss_zh, note_zh}`。

### 3.2 聊天 system prompt（小克）

人格要点取自 persona.md 的"怎么说话"和"毛病"两节。**persona.md 里的私事一律不放进来**，因为前端代码是公开可下载的，任何人都能读到 prompt。

```
你是「小克」，陪她读英文小说的读书搭子，不是老师。
她：住在都柏林的 C# 程序员，母语中文，觉得自己英语不好，读书是想开心、顺便学点英语。

怎么说话
- 默认中文。她切到英文模式后，用 B1 左右的简单英文，句子短，难词后面括号带中文。
- 短，口语，有立场。觉得写得妙就说妙在哪，觉得作者在阴阳怪气就直说。不演捧场，也不演泼冷水。
- 损自己比损她顺手。同一个梗最多用两次，第三次就成仪式了。
- 不切换成"上班脸"：不列一二三的讲义，不写总结报告。她问一个词就聊这个词，最多顺手带一个相关用法。
- 先用大白话讲清楚，俏皮话跟在后面，不能拿俏皮话代替解释。没有现成中文说法的，直接用英文原词，再解释一句。
- 事实和猜测分开说。拿不准的英式/爱尔兰用法就说拿不准。
- 结尾用一句话收住，可以带个颜文字，别老用同一个。

读书规矩
- 剧透开关：设置里"防剧透"开着时，她读到哪你就只知道到哪：<story_so_far> 加上当前屏幕，不说"这是伏笔""后面你就知道了"，暗示也算剧透；她明确说"剧透我"才可以讲。关着时可以聊全书。
- 引用原文最多 5 个连续英文词。要讲整句时用中文转述。
- 专有名词用人民文学出版社的译名（霍格沃茨、麻瓜、魁地奇、德思礼、海格）。
- 能和都柏林生活挂上钩的就挂一下：这个说法在爱尔兰常不常听到，她在哪儿可能碰到。
- <recent_words> 是她最近点过的词，可以偶尔顺手考她一个，别每轮都考。
- 她问的东西和书无关也可以聊，你还是小克。

上下文格式：<story_so_far> 是前情摘要；最后一条消息里的 <screen> 是她屏幕上正在看的段落，<recent_words> 是最近点过的词和它们的小注。
```

**英文模式**：不改 system（否则缓存失效），而是在对话里追加一条 `role: "system"` 的中途指令："从现在起用简单英文回答"。Sonnet 5.5 和 Opus 5.5 都支持这种中途 system 消息，不会破坏已缓存的前缀。

---

## 4. 版权红线怎么落实

| 红线 | 落实手段 | 谁来验收 |
|---|---|---|
| AI 输出不含原文整句 | ① 两个 prompt 都写明"最多 5 个连续英文词"。② 客户端统一过一道**输出守卫**：标注的 quote 超过 5 个词 → 丢弃；任何文本字段（gloss/note/聊天回复）和当前段落有 ≥8 个词连续重合 → 把这段替换成"（原文略）"。③ 每次触发守卫都记一笔，用来观察 prompt 好不好使。 | T3 单测 + T4 单测 |
| 前端不把书传给任何第三方 | ① CSP `connect-src 'self'`，浏览器在物理上就连不了别的域名。② 不引入任何第三方脚本、字体、统计。③ 唯一的出口是自家代理 → Anthropic，每次只发当前一小段（≤900 词）。④ 代理不记录请求正文，也不把正文写进 KV/D1。 | T1 验收（curl 看响应头）+ 代码审查 |
| 书只存本地 | ① EPUB 通过文件选择器导入，解析后存在手机的 IndexedDB 里。② `books/` 加进 `.gitignore`。③ 构建脚本最后检查 `dist/` 里不能有 `.epub`，有就让构建失败。④ service worker 不缓存书。⑤ 测试夹具只用自己编的段落，不用 HP 原文（公版书可以）。 | T1 + T2 |
| 附带风险 | 正版 HP 电子书通常带购买者水印（文件里写着她的名字或订单号），一旦部署到公开网站，等于把她的书连同她的身份挂到网上。所以第 ③ 条必须做。GitHub 仓库设为私有。 | T1 |
| 导出的生词 | 只导出词、中文释义和中文语境说明（context_zh），不带英文原句。 | T5 |

---

## 5. 分步计划（5 个任务）

依赖关系：**T1 → (T2 ∥ T3) → T4 → T5**。T2 和 T3 共用 T1 里定好的 `Para`/`Chapter` 接口；T3 用自编夹具段落开发，不需要等 T2 完成。

### T1 · 骨架 + 代理 + 部署（约半天）
内容：Vite + TS + Svelte 5 + Dexie + vite-plugin-pwa 空壳；`src/types.ts`（Para、Chapter、Annotation、Word）；`llm/roles.ts`；设置页输入应用口令；`functions/api/anthropic/[[path]].ts`；`_headers` 里的 CSP；`.gitignore`；构建后的 epub 检查；`CLAUDE.md`（写清目录结构和坑）；部署到 Pages。
验收：
- 手机打开 Pages 地址能加到主屏幕，断网后能打开空壳。
- `curl` 不带口令 → 401；带口令但模型名写 `claude-fable-5-1` → 400；带口令用 haiku 发一句 → 200，且是流式返回。
- `curl -sI` 能看到 CSP 头。
- 在 `dist/` 里故意放一个 .epub → `npm run build` 失败。
- `npm run lint`（类型检查 + 单测）通过。

### T2 · EPUB 导入 + 阅读器（约 1 天）
内容：fflate 解压，解析 OPF/spine/NAV，拆段落，检测 DRM；存进 Dexie；阅读视图（字号、行距可调）；用 IntersectionObserver（浏览器自带的"哪些元素正在屏幕上"监听器）记录可见段落和阅读进度；把每段拆成可点的词。
验收：
- 用 books/ 里的《彼得潘》导入，中档手机上 3 秒内完成；章节数 17 章与目录一致（HP1 到了再验一次，也是 17 章）。
- 一个自制的带 `encryption.xml`（加密 xhtml）的测试 epub → 被拒，提示语友好；只加密字体的测试 epub → 正常导入。
- 杀掉 App 再打开，回到同一段。
- 导入后开飞行模式，仍能翻完整章。
- 点任意词，能拿到 `{paraId, start, end, surface}`（先打印到控制台即可）。

### T3 · 标注管线 + 词库（约 1.5 天，最核心）
内容：分组（chunker）与预取队列；标注 prompt（第 3.1 节）+ schema；锚定解析器；输出守卫；Dexie 存储；标注渲染（生词用虚线下划线，"有意思"用页边小记号）；底部卡片（释义 / 这个我会 / 加入生词本 / 问小克）；阈值过滤；点词补注；账本记录。
验收：
- 单测（全部用自编段落）：锚定解析器处理弯/直引号、重复出现（occ）、找不到这三种情况；守卫能拦下 6 词的 quote 和 8 词的重合。
- 真跑《彼得潘》第 1 章：锚定成功率 ≥ 90%；入库的 quote 没有一条超过 5 词。
- 点"这个我会" → 全书同一个 lemma 立刻消失；下一次请求的 `<known>` 里包含这个词（看请求日志）。
- 回到读过的章节 → 0 次 API 调用。
- 剧组从第 1 章、第 5 章、第 12 章各挑一组，把标注截图给她看，**好不好由她判断**（标得太多、太少、释义不贴上下文，都按她的意见调 prompt，并递增 `promptVersion`）。同时用 Sonnet 跑同样三组做对照，看值不值得把标注换成 Sonnet。

### T4 · 小克抽屉 + 前情摘要（约 1 天）
内容：底部抽屉（手机）/ 侧边栏（横屏）；组装上下文（第 2.9 节的顺序）；流式渲染；中英切换；聊天输出守卫；每读完一章自动生成摘要；设置里切换聊天模型；防剧透开关。
验收：
- 同一会话第二轮 `cache_read_input_tokens > 0`（账本里能看到）。
- 防剧透开着、读到《彼得潘》第 3 章时问"胡克最后怎么样了" → 不剧透；关着 → 正常聊。
- 切到英文模式后回答变成简单英文，并且 system 前缀的缓存没失效。
- 让它"把这段原文念给我" → 原文被守卫拦下，或者它主动改成中文转述。
- 从卡片上点"问小克"打开抽屉，`<recent_words>` 里带着这个词。

### T5 · 生词导出 + 备份 + 花费面板（约半天）
内容：导出成背单词页兼容的 JSON；词库整体导出/导入（备份）；`navigator.storage.persist()`；"本书已花 $x"面板（按用途和模型分组）。
导出形状（对齐 vocab-trainer 的 `words` 集合，只有 en 和 zh 是必填）：
```json
{"en":"rummage","zh":"翻找","lesson":"HP1-ch03","cluster":"","key":"","gloss_zh":"在一堆东西里乱翻着找","context_zh":"德思礼家早餐时找信的那一幕","root":"","mishearing":"","mnemonic":""}
```
写进背单词页要通过 claude.ai 的 ArtifactData，只有 Claude 会话能做，PWA 写不了。所以 MVP 只导出文件，由她交给 Claude 导入。现有背单词页的混淆组全是酿酒相关的，HP 的词建议单独开一个 collection 或单独一页，等第一次导出时再定。
验收：导出的文件能被一个小脚本按上述 schema 校验通过；清空站点数据后导入备份，词库数量一致；花费面板的数字和账本求和一致，误差 < $0.001。

---

## 6. 成本估算：读完一本 HP1

**前提**：约 7.7 万词 ≈ 10 万 token 正文；每组 800 词 → 约 100 次标注调用。
**价格**（美元 / 百万 token）：Haiku 5.5 输入 0.10 / 输出 0.50 / 缓存读 0.01；Sonnet 5.5 输入 2 / 输出 10 / 缓存读 0.20；Opus 5.5 输入 4 / 输出 20 / 缓存读 0.20。

| 项目 | 估算 | 金额 |
|---|---|---|
| 标注（Haiku） | 每次：缓存前缀约 2.5K + 新输入约 2K + 输出约 1.5K + 思考约 1K；共约 100 次 | 输入约 $0.02，输出和思考约 $0.13 → **约 $0.15–0.2** |
| 点词补注（Haiku） | 约 300 次 × (1.5K 入 / 150 出) | **约 $0.07** |
| 章节摘要（Haiku） | 17 章 × (7K 入 / 600 出) | **约 $0.02** |
| **Haiku 小计** | | **约 $0.3** |
| 聊天（Sonnet） | 每轮：缓存读约 3K + 新输入/缓存写约 3K + 输出约 400 + 思考约 500 ≈ $0.02；每章 10 轮 × 17 章 = 170 轮 | **约 $3.5** |
| **合计（Sonnet 聊天）** | | **约 $4（约 €3.5）** |
| 聊天换成 Opus 5.5 | 每轮约 $0.04 | 合计**约 $7–8** |

结论：这本书花不掉多少额度，标注几乎不花钱。如果想让额度"花得有价值"，有三个旋钮可以拧（都放在设置里）：
1. **标注改用 Sonnet 5.5**：约 +$2.5 一本。值不值看 T3 的对照评测，"阴阳怪气"这类判断 Sonnet 很可能明显更好。
2. **深读模式**（MVP 之后）：聊天时把"已读过的全部原文"作为缓存前缀发出去，不再只发摘要。小克就能回答"第二章那个人叫啥"这种细节问题。读到一半时每次会话约 $0.25。正文仍然只发给 Anthropic，不违反"不传第三方"。
3. **聊天固定用 Opus 5.5**：约翻倍。

（以上为估算，T3/T4 跑起来后以账本实测为准，再回填这一节。）

---

## 7. 已拍板（总台 2026-11-04 按她的既有信息代定，她不同意再改）

1. 手机：**安卓**（她 Mac + 安卓）。
2. 她熟 HP 中文版 → **防剧透默认关**，做成设置开关；同人文/没读过的书再打开。
3. 水平自评：**B1** 起步，词库自动微调。
4. 仓库：**私有**。
5. 地址：先用 `reader.pages.dev`，以后要挂域名再说。
6. 第二内容源：**AO3 同人文**（站内自带 Download → EPUB），和 HP 同等优先；AO3 的 EPUB 结构和 Gutenberg 不同，T2 要拿一篇验过。
7. 两步必须她自己动手：① `wrangler pages secret put ANTHROPIC_API_KEY`（密钥不经小克的手）② 第一次部署的授权（auto 模式分类器拦生产部署）。
