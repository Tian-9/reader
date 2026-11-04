# 英语阅读器 · 开发约定

方案在 PLAN.md（已定稿，改设计先改文档）。当前进度和下一步在 HANDOFF.md。

## 目录

```
PLAN.md                         方案（架构、prompt 草案、版权红线、T1-T5 分工）
HANDOFF.md                      进度交接（各 T 段 + 收口清单）
books/                          测试用公版书（gitignore，不许动、不许进 dist/）
shots/                          验收截图和真跑报告（gitignore，不入仓）
functions/api/anthropic/[[path]].ts   Pages Function 代理：口令→真 key，白名单，流式透传
public/_headers                 CSP 等静态响应头
public/icon-*.png               PWA 占位图标（scripts/make-icons.mjs 生成）
scripts/
  check-dist.mjs                构建前后检查 dist/ 里没有电子书
  vrun.mjs                      用 vite 跑 TS 脚本（node scripts/vrun.mjs x.ts）
  t3-real.ts / t4-real.ts       真跑验收（直连 Anthropic，要 ANTHROPIC_API_KEY；--mock 假跑）
  real-all.sh                   有 key 时一条命令顺序跑 t3-real + t4-real（合计 ≤ $2）
  t4-browser.mjs                headless Chrome 走一遍 导入→标注→点词→卡片→问小克→抽屉→章末摘要（API 用假回复）
  t3-epub.ts / t3-shot.mjs / t3-demo/   T3 的抽段、截图、标注层 demo
src/
  types.ts                      共享接口：Para / Chapter / Annotation / Word / ChatRecord … ← 各 T 的合同（只做加法）
  db/db.ts                      Dexie 表结构 + chapterParas()（改表加新 version，只做加法）
  epub/                         T2：parse（切章拆段）、drm、import（入库/当前书）、words（分词）、errors
  annotate/                     T3：chunker 分组、pipeline 标注调用、anchor 锚定、guard 输出守卫、queue 预取、
                                tap 点词补注、words 词库三态、profile 拼 user 消息、visible 阈值过滤、text
  chat/                         T4：context（PLAN 2.9 上下文组装，纯函数）、session（一轮聊天：流式/守卫/记账/存库）、
                                summary（章末触发 + 滚动摘要）、autosummary.svelte.ts（盯阅读状态触发摘要）
  components/                   ReaderView（T2 阅读视图，里面挂 T3 的 AnnotationLayer）、ParaText、ImportButton、
                                AnnotationLayer + WordCard（T3）、ChatDrawer（T4 小克抽屉）、reading.svelte.ts（阅读共享状态）
  llm/roles.ts                  按用途配模型 / effort / max_tokens（业务代码不写死模型名）
  llm/client.ts                 SDK 客户端（懒加载）、baseParams / betaParams、ping
  llm/pricing.ts, ledger.ts     单价表、花费账本
  llm/prompts/                  annotate（标注）、tap（点词）、chat（小克 + 中英切换指令）、summary（章节摘要）
  settings.svelte.ts            设置 $state + 读写
  pwa.svelte.ts                 service worker 注册 + "有新版本"横条
  App.svelte, pages/            界面（中文，手机优先）。ReaderPage 挂 ReaderView + ChatDrawer + 自动摘要
test/                           单测（vitest + fake-indexeddb）。不能放进 functions/，见下面的坑
```

## 命令

- `npm run dev`：本地前端（没有代理，调不了 API）
- `npm run lint`：类型检查（svelte-check，覆盖 src/ functions/ test/）+ 单测。**改完必须过**
- `npm run build`：构建前查 dist/ 残留的书 → vite build → 构建后再查一遍。**必须过**
- `npm run proxy:dev`：先 build，再用这个起本地 Pages（静态 + 代理），端口 8788，假口令 `dev-token`、假 key。
  假 key 下合法请求会被 Anthropic 回 401 `invalid x-api-key`，这正说明转发通了
- 部署（总台/她做，剧组别跑）：`npm run build && ~/node_modules/.bin/wrangler pages deploy dist --project-name reader --branch main`
- secret（只有她敲）：`~/node_modules/.bin/wrangler pages secret put APP_TOKEN --project-name reader`，`ANTHROPIC_API_KEY` 同理

## 容易踩的坑

- **SDK 1.x 把 apiKey 放在 `Authorization: Bearer` 里发，不是 `x-api-key`。** 代理两个都认（x-api-key 优先），两个头都不会转发上游。用 curl 测时用哪个都行。
- **functions/ 下每个文件都会变成路由**，测试文件放进去会被 wrangler 打包（还会 import vitest 失败）。代理的单测放 test/。
- **Svelte 5 的 `$state` 是 Proxy，直接存 Dexie 会 DataCloneError。** 写库前 `$state.snapshot(x)`（settings.svelte.ts 示范了）。
- **liveQuery 里不能写库。** 依赖 Svelte 状态的查询要显式传依赖，查询函数里读到的状态不会被追踪。
- **改 Dexie 表结构**：加新的 `this.version(n+1).stores(...)`，别改已有版本的定义，否则她手机上的老库打不开。
- **system prompt 只放稳定内容。** 时间、当前段落、词库样本这类易变内容只能进最后一条 user 消息，否则缓存全废（pocketverse 踩过）。切英文模式用中途 `role: "system"` 消息，不改 system。
- **模型名只写在 llm/roles.ts。** 代理白名单（ALLOWED_MODELS / ALLOWED_BETAS）和 roles.ts 要同步改，test/roles.test.ts 会核对。新增 beta 头也要进代理白名单，不然 400。
- **代理的 `fallbacks` 只放行 `"default"`。** 数组形式可以指定任意模型，等于绕过白名单。fast mode 也被拦。
- **Haiku 5.5 没有服务器端 fallback。** `betaParams()` 只给 Sonnet/Opus 带 fallback；Haiku 被拒（`stop_reason: "refusal"`）时客户端用 `REFUSAL_RETRY_MODEL` 重试一次（T3 实现）。
- **SDK 约 360KB，是懒加载的**（`await getClient(token)`）。别在顶层 `import Anthropic from '@anthropic-ai/sdk'`（值导入），类型用 `import type`。
- **service worker 用 prompt 模式**：新版本装好后出横条，她点了才切。别改成 autoUpdate——自动接管会清旧缓存，正开着的旧页面再懒加载分包会 404。
- **CSP 是 `connect-src 'self'`**，不许加第三方脚本、字体、统计；Chrome headless 下 `--dump-dom` 一次性模式里 IndexedDB 会卡住，测页面用 CDP 正常会话（HANDOFF 里有说明）。
- **书不进仓库、不进 dist/**：.gitignore 有 `books/` 和 `*.epub`。测试夹具里的 EPUB 用代码现场拼（fflate `zipSync`），别提交 .epub 文件；夹具文本只用自编段落或公版书，不用 HP 原文。
- 开发机是 macOS（文件系统不区分大小写）：两个文件名不能只差大小写。
- **聊天历史只追加不改写。** 助手回复连 thinking 块原样存、原样发回；输出守卫只改显示（ChatRecord.display），不改 messages。改历史 = 缓存从那里断 + Sonnet/Opus 5.5 的 thinking 签名失效（新账号直接 400）。中途 `role: "system"` 消息必须紧跟在 user 后面，不能放 messages[0]。
- **页边 ※ 别伸出屏幕。** ReaderView 的 article 右边留了 14px；伸出去手机上整页会左右晃，headless 里还会把点击坐标带偏。
- **$state.raw 里的数组被就地 push 后，重新赋值外层对象时数组也要换新**（`{...s, display: [...s.display]}`），不然 $derived 看不到变化。

## 文案

- 界面只做中文。术语第一次出现带一句大白话解释。
