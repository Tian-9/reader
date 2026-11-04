# 英语阅读器 · 开发约定

方案在 PLAN.md（已定稿，改设计先改文档）。当前进度和下一步在 HANDOFF.md。

## 目录

```
PLAN.md                         方案（架构、prompt 草案、版权红线、T1-T5 分工）
HANDOFF.md                      进度交接
books/                          测试用公版书（gitignore，不许动、不许进 dist/）
functions/api/anthropic/[[path]].ts   Pages Function 代理：口令→真 key，白名单，流式透传
public/_headers                 CSP 等静态响应头
public/icon-*.png               PWA 占位图标（scripts/make-icons.mjs 生成）
scripts/check-dist.mjs          构建前后检查 dist/ 里没有电子书
src/
  types.ts                      共享接口：Para / Chapter / Annotation / Word / … ← T2、T3 的合同
  db/db.ts                      Dexie 表结构 + chapterParas()
  llm/roles.ts                  按用途配模型 / effort / max_tokens（业务代码不写死模型名）
  llm/client.ts                 SDK 客户端（懒加载）、baseParams / betaParams、ping
  llm/prompts/annotate.ts       标注 system + user 模板 + schema（PLAN 3.1 原文）
  llm/prompts/chat.ts           小克 system（PLAN 3.2 原文）
  settings.svelte.ts            设置 $state + 读写
  pwa.svelte.ts                 service worker 注册 + "有新版本"横条
  App.svelte, pages/            界面（中文，手机优先）
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

## 文案

- 界面只做中文。术语第一次出现带一句大白话解释。
