# 英语阅读器 · 开发约定

方案在 PLAN.md（已定稿，改设计先改文档）。当前进度和下一步在 HANDOFF.md。

## 目录

```
PLAN.md                         方案（架构、prompt 草案、版权红线、T1-T5 分工）
HANDOFF.md                      进度交接（各 T 段 + 收口清单）
books/                          测试用公版书（gitignore，不许动、不许进 dist/）
shots/                          验收截图和真跑报告（gitignore，不入仓）
legacy/                         原 Cloudflare 代理方案存档（functions/、wrangler.toml、proxy.test.ts），不参与构建和测试
.github/workflows/pages.yml     推到 main → lint + build → 部署 GitHub Pages（照 pocketverse）
public/icon-*.png               PWA 占位图标（scripts/make-icons.mjs 生成）
scripts/
  check-dist.mjs                构建前后检查 dist/ 里没有电子书
  vrun.mjs                      用 vite 跑 TS 脚本（node scripts/vrun.mjs x.ts）
  t3-real.ts / t4-real.ts       真跑验收（直连 Anthropic，要 ANTHROPIC_API_KEY；--mock 假跑）
  real-all.sh                   有 key 时一条命令顺序跑 t3-real + t4-real（合计 ≤ $2）
  direct-browser.mjs            直连验收（真请求）：manifest / SW 在 /reader/ / 断网 / 设置页填 key 测一下 / 导入→真标注，截 direct-settings.png
  t4-browser.mjs                headless Chrome 走一遍 导入→标注→点词→卡片→问小克→抽屉→章末摘要（api.anthropic.com 用假回复）
  t5-browser.mjs                headless：花费面板对账 → 导出生词过校验 → 备份 → 清空站点数据 → 导入备份条数一致
  validate-export.mjs           按 schema 校验导出的生词 / 词库备份（node scripts/validate-export.mjs x.json）
  t3-epub.ts / t3-shot.mjs / t3-demo/   T3 的抽段、截图、标注层 demo
  fix1-real.ts / fix1-browser.mjs  首用反馈修复的真跑（过滤前后对比，$0.3 上限）和 headless 验收（闸、小牌子、按钮、本章生词）
  make-common-words.mjs         从 NGSL 原始 CSV 生成 src/annotate/common-words.ts（下载地址在文件头）
src/
  types.ts                      共享接口：Para / Chapter / Annotation / Word / ChatRecord … ← 各 T 的合同（只做加法）
  db/db.ts                      Dexie 表结构 + chapterParas()（改表加新 version，只做加法）
  epub/                         T2：parse（切章拆段）、drm、import（入库/当前书）、words（分词）、errors
  annotate/                     T3：chunker 分组、pipeline 标注调用、anchor 锚定、guard 输出守卫、queue 预取、
                                tap 点词补注、words 词库三态、profile 拼 user 消息、visible 阈值过滤 + 常用词/专有名词两道硬闸、text、
                                common-words（NGSL 高频词表，CC BY-SA 4.0，生成的，别手改）
  chat/                         T4：context（PLAN 2.9 上下文组装，纯函数）、session（一轮聊天：流式/守卫/记账/存库）、
                                summary（章末触发 + 滚动摘要）、autosummary.svelte.ts（盯阅读状态触发摘要）
  components/                   ReaderView（T2 阅读视图，里面挂 T3 的 AnnotationLayer）、ParaText、ImportButton、
                                AnnotationLayer + WordCard（T3）、ChatDrawer（T4 小克抽屉）、reading.svelte.ts（阅读共享状态）
  llm/roles.ts                  按用途配模型 / effort / max_tokens（业务代码不写死模型名）+ 请求白名单 checkRequest
  llm/client.ts                 SDK 客户端（懒加载，直连 api.anthropic.com）、guardedFetch（发出前过白名单）、baseParams / betaParams、ping
  llm/pricing.ts, ledger.ts     单价表、花费账本
  llm/spend.ts                  T5：花费面板（按用途/模型分组求和、$ 三位小数）
  export/                       T5：vocab（生词导出，背单词页形状，不带原句）、backup（词库+设置备份/合并导入，不含 API key）
  storage.svelte.ts             T5：启动时 navigator.storage.persist()、下载 JSON 小工具
  llm/prompts/                  annotate（标注）、tap（点词）、chat（小克 + 中英切换指令）、summary（章节摘要）
  settings.svelte.ts            设置 $state + 读写
  pwa.svelte.ts                 service worker 注册 + "有新版本"横条
  App.svelte, pages/            界面（中文，手机优先）。ReaderPage 挂 ReaderView + ChatDrawer + 自动摘要
test/                           单测（vitest + fake-indexeddb）。direct.test.ts 管白名单和直连请求形状
```

## 命令

- `npm run dev`：本地前端，地址 http://localhost:5173/reader/（注意子路径）。设置页填 key 就能直连调 API（dev 下不注入 CSP）
- `npm run lint`：类型检查（svelte-check，覆盖 src/ test/）+ 单测。**改完必须过**
- `npm run build`：构建前查 dist/ 残留的书 → vite build → 构建后再查一遍。**必须过**
- `npm run preview`：起构建产物，http://localhost:4173/reader/（和线上一样的子路径、CSP、service worker）
- 直连真跑验收：`npm run build && npm run preview &` 然后 `node scripts/direct-browser.mjs`（key 自动读 `~/.config/reader/key`，一趟约 $0.005，`--budget` 默认 0.5）
- 部署：推到 GitHub 的 main 分支，Actions 自动构建发布（`.github/workflows/pages.yml`）。仓库 Settings → Pages → Source = GitHub Actions。没有 secret 要设

## 容易踩的坑

- **直连模式：key 存本地。** 她的 Anthropic API key 存在 IndexedDB（Dexie `settings.apiKey`，和 pocketverse 同款），只在她手机上。备份不带它、导入备份保留本机的；日志、报告、截图（设置页是密码框）里都不许出现。`appToken` 是代理时代的遗留字段，`normalizeSettings` 读到就扔。
- **浏览器直连要两样：** SDK 的 `dangerouslyAllowBrowser: true` + 请求头 `anthropic-dangerous-direct-browser-access: true`（SDK 1.x 开了前者会自动带后者，client.ts 里又显式写了一遍）。少了 Anthropic 不回 CORS 头，浏览器直接拦。
- **SDK 1.x 把 apiKey 放在 `Authorization: Bearer` 里发，不是 `x-api-key`。** Anthropic 两个都认。
- **子路径 base `/reader/`（GitHub Pages）。** 代码里别写以 `/` 开头的绝对路径（`/icon.png`、`fetch('/x')`）；index.html 用 `%BASE_URL%`，manifest 的 scope / start_url / id 跟 `vite.config.ts` 的 `BASE` 走，workbox 的 `navigateFallback` 写相对的 `'index.html'`。换仓库名只改 `BASE`。
- **CSP 在 `<meta>` 里，不在响应头里**（GitHub Pages 设不了响应头，`_headers` 已删）。由 vite.config.ts 的 `cspMeta()` 插件只在 build 时注入；dev 下不注入（热更新的 ws 会被拦）。所以验 CSP 一定用 `npm run preview`，不是 dev。
- **Svelte 5 的 `$state` 是 Proxy，直接存 Dexie 会 DataCloneError。** 写库前 `$state.snapshot(x)`（settings.svelte.ts 示范了）。
- **liveQuery 里不能写库。** 依赖 Svelte 状态的查询要显式传依赖，查询函数里读到的状态不会被追踪。
- **改 Dexie 表结构**：加新的 `this.version(n+1).stores(...)`，别改已有版本的定义，否则她手机上的老库打不开。
- **system prompt 只放稳定内容。** 时间、当前段落、词库样本这类易变内容只能进最后一条 user 消息，否则缓存全废（pocketverse 踩过）。切英文模式用中途 `role: "system"` 消息，不改 system。
- **模型名只写在 llm/roles.ts。** 白名单（MODELS / ALLOWED_BETAS / MAX_TOKENS_CAP）也在 roles.ts，`guardedFetch` 每个请求发出前过 `checkRequest`，不过的本地回 400（错误信息以"本地拦下："开头），请求不出浏览器。新增 beta 头要进 ALLOWED_BETAS；test/roles.test.ts 核对每个用途 × 每个模型的参数都过得了白名单。
- **`fallbacks` 只放行 `"default"`。** 数组形式可以指定任意模型，等于绕过白名单。fast mode 也被拦。
- **Haiku 5.5 没有服务器端 fallback。** `betaParams()` 只给 Sonnet/Opus 带 fallback；Haiku 被拒（`stop_reason: "refusal"`）时客户端用 `REFUSAL_RETRY_MODEL` 重试一次（T3 实现）。
- **SDK 约 360KB，是懒加载的**（`await getClient(settings.apiKey)`）。别在顶层 `import Anthropic from '@anthropic-ai/sdk'`（值导入），类型用 `import type`。
- **service worker 用 prompt 模式**：新版本装好后出横条，她点了才切。别改成 autoUpdate——自动接管会清旧缓存，正开着的旧页面再懒加载分包会 404。
- **CSP 是 `connect-src 'self' https://api.anthropic.com`**，不许加第三方脚本、字体、统计；Chrome headless 下 `--dump-dom` 一次性模式里 IndexedDB 会卡住，测页面用 CDP 正常会话（HANDOFF 里有说明）。
- **书不进仓库、不进 dist/**：.gitignore 有 `books/` 和 `*.epub`。测试夹具里的 EPUB 用代码现场拼（fflate `zipSync`），别提交 .epub 文件；夹具文本只用自编段落或公版书，不用 HP 原文。
- 开发机是 macOS（文件系统不区分大小写）：两个文件名不能只差大小写。
- **聊天历史只追加不改写。** 助手回复连 thinking 块原样存、原样发回；输出守卫只改显示（ChatRecord.display），不改 messages。改历史 = 缓存从那里断 + Sonnet/Opus 5.5 的 thinking 签名失效（新账号直接 400）。中途 `role: "system"` 消息必须紧跟在 user 后面，不能放 messages[0]。
- **页边 ※ 别伸出屏幕。** ReaderView 的 article 右边留了 14px；伸出去手机上整页会左右晃，headless 里还会把点击坐标带偏。
- **本机真跑用的 key 在 `~/.config/reader/key`（一行，chmod 600），`scripts/real-all.sh` 自动读。** 别 cat、别 echo、别写进报告或别的文件。
- **结构化输出（标注/补注/摘要）的 max_tokens 是思考 + 正文共用。** Haiku 5.5 effort=medium 的 adaptive thinking 实测吃 4–5.6K，JSON 会被截断；`callStructured` 截断时自动用 effort=low 重发一次。调小上限前先看真跑的 thinking_tokens。
- **备份文件不带 API key**（会进下载目录、发给 Claude 会话）。导入时保留本机的 key；`scripts/validate-export.mjs` 见到 apiKey / appToken 就判不过。
- **仓库是公开的。** 推之前确认历史里没有 key：`git log --all -p | grep -cE 'sk-an[t]'` 必须是 0（正则写成 `[t]` 是为了这行文档自己不被匹配）。所以测试和脚本里的假 key 一律别用 Anthropic key 的前缀，写 `test-key-…` / `mock-key-…`。也确认没有书、没有 shots/。
- **显示过滤不信模型的 level。** 常用词闸 + 专有名词闸在 `visible.ts`（PLAN 2.4(d)），被闸住的不划线、不进词库、不进导出、不进 `<known>/<unknown>`；只有她点了"加入生词本"的能越过。改阈值档位改 `COMMON_TIER`。`common-words.ts` 是 CC BY-SA 4.0 的改编数据，文件头的署名别删。
- **$state.raw 里的数组被就地 push 后，重新赋值外层对象时数组也要换新**（`{...s, display: [...s.display]}`），不然 $derived 看不到变化。

## 文案

- 界面只做中文。术语第一次出现带一句大白话解释。
- 人设功能（地域梗之类）她说想到再加，现在不加。prompt 里不写她住哪、不提"某地人怎么说"。
