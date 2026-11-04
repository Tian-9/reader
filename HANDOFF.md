# HANDOFF

## 当前状态（2026-11-04，T1 完成，未部署）

骨架、代理、可部署空壳都在本地跑通了。没部署、没设 secret、没推 GitHub（仓库只在本地 git）。

### T1 验收结果

| 项 | 结果 |
|---|---|
| `npm run build` | 通过 |
| dist/ 里放一个 .epub 再 build | 失败（构建前检查拦下）；删掉后恢复 |
| public/ 里放 .epub（会被复制进 dist） | 失败（构建后检查拦下） |
| 把 epub 改名成 .png 混进去 | 失败（按 EPUB 文件头识别） |
| `npm run lint`（svelte-check + 31 个单测） | 通过，0 错误 0 警告 |
| wrangler pages dev：不带口令 | 401 |
| 带口令、模型 `claude-fable-5-1` | 400 |
| 另测：max_tokens 9000 / 非白名单 beta / GET /v1/models | 400 / 400 / 404 |
| 带口令的合法请求 + 假 key | 被转发到 api.anthropic.com，上游回 401 `invalid x-api-key`（转发通路是通的） |
| 用真 SDK（不是 curl）打本地代理 | 同上，beta 流式 + `fallbacks: "default"` 也能过代理 |
| `curl -sI` 看 CSP | 有，和 PLAN 2.7 一字不差，另加了 nosniff、no-referrer |
| 桌面 Chrome（headless）| 外壳渲染正常，0 控制台报错、0 CSP 违规；设置能保存；断网刷新仍能打开；部署新版后出"有新版本"横条，点了切新版 |
| **200 分支（真 key + Haiku 一句话 → 200 流式）** | **没验**：要真 key，等她设好 secret 后验（见下面"待她做"） |

### 和 PLAN 不一样的地方（都是补，不是改方向）

1. **代理也认 `Authorization: Bearer` 口令。** PLAN 2.6 写的是 `x-api-key`，但 `@anthropic-ai/sdk` 1.x（2026-10-21 发布的新大版本）把 apiKey 一律放在 `Authorization: Bearer` 里发。不补的话前端所有请求都会 401。两个头都不转发上游。
2. **代理多拦了三样：** `fallbacks` 只放行 `"default"`（数组形式能指定任意模型，等于绕过白名单）；`speed: "fast"`（贵一倍）；请求体超过 256KB → 413。请求头只转发 content-type / anthropic-version / accept / anthropic-beta，其余（cookie、浏览器直连标记、SDK 遥测头）全丢。
3. **Dexie 多了两张表：** `chapters`（存目录标题，PLAN 2.4(b) 没列）和 `settings`。`ledger` 加了可选的 `bookId`（"这本书花了多少"要按书分）。
4. **SDK 懒加载**：首屏只有 Dexie + Svelte（gzip 约 50KB），SDK（gzip 约 80KB）第一次调 API 才下载，service worker 照样预缓存，离线不受影响。
5. **设置页有个"测一下口令"按钮**：发一句最短的 Haiku 请求（< $0.0001）。能分清"口令不对"和"口令对了但服务器上的 key 被 Anthropic 拒了"。

## 待她做（剧组不碰）

1. Cloudflare Pages 建项目 `reader` 并第一次部署（总台处理）。
2. 设两个 secret：
   ```
   ~/node_modules/.bin/wrangler pages secret put APP_TOKEN --project-name reader
   ~/node_modules/.bin/wrangler pages secret put ANTHROPIC_API_KEY --project-name reader
   ```
   APP_TOKEN 随便起一个长一点的口令，手机设置页填同一个。
3. 验 200 分支（设完 secret、部署后）：
   ```
   curl -sN https://reader.pages.dev/api/anthropic/v1/messages \
     -H "x-api-key: <她的 APP_TOKEN>" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
     -d '{"model":"claude-haiku-5-5","max_tokens":200,"stream":true,"messages":[{"role":"user","content":"说一句你好"}]}'
   ```
   应该看到 `event: message_start` … 一行行流出来。或者手机上设置页点"测一下口令"，显示"通了"即可。
4. 建议在 Anthropic 控制台给这个 key 所在的 workspace 设月度花费上限（PLAN 2.6）。
5. 手机上加到主屏幕、断网再开一次（PLAN T1 验收的手机部分，桌面 Chrome 已模拟过）。

## T2 / T3 从哪接

**共享接口全在 `src/types.ts`，Dexie 表在 `src/db/db.ts`。** 两边并行时只认这两个文件；要改字段先改这里，再通知另一边。

### T2（EPUB 导入 + 阅读器）—— 2026-11-04 完成，未部署

提交：`6af04b9`（加 fflate、jsdom）、`6e6ed31`（T2 本体）。

**验收结果**

| 项 | 结果 |
|---|---|
| 彼得潘导入 | 17 章，章名和目录逐字一致（`Chapter I. PETER BREAKS THROUGH` … `Chapter XVII. WHEN WENDY GREW UP`），1654 段，47,087 词（4.8 万的 -1.9%）。正文里没有 "Project Gutenberg" 字样，末段是 `THE END` |
| 导入速度 | headless Chrome、CPU 降速 4 倍（模拟中档手机）：点选文件到第一段出现 ~590ms，解析+入库 ~460ms |
| 绿野仙踪 | 24 章（`Chapter I The Cyclone` … `Chapter XXIV Home Again`），39,139 词。**Introduction 不算章**（算前置页跳过，见下面"切章规则"） |
| 自制带 encryption.xml（加密 xhtml）的 epub | 拒绝，提示语和 PLAN 2.3 一字不差。单测 + 浏览器里实测各一次（浏览器用的是给彼得潘塞了一个 encryption.xml 的副本，放 scratchpad，没进仓库） |
| 只加密字体（idpf / Adobe 两种算法） | 正常导入（单测） |
| rights.xml / sinf.xml / 乱码 / 非 zip | 拒绝（单测） |
| 刷新模拟杀掉重开 | 滚到 c01p0037 → 库里存 c01p0037 → 刷新后屏幕最上面还是 c01p0037 |
| 断网 | service worker 接管后断网刷新能打开，翻到第 2 章（104 段）滚到章末 |
| 点词 | `{"paraId":"c01p0001","start":346,"end":351,"surface":"can’t"}`，偏移和原文对得上；console.log + `word-tap` 事件都有。兜底路径（段内没有词 span，按坐标算）也能拿到 |
| 字号行距 | 调到 28px 后刷新还是 28px，调字号前后屏幕最上面是同一段 |
| `npm run lint` / `npm run build` | 通过（0 错 0 警告；在只含 T2 提交的干净 worktree 里也单独跑过） |
| 截图（390px 宽） | `shots/t2-import.png`（导入后）、`shots/t2-large.png`（28px 字号） |
| AO3 EPUB | **待验**：2026-11-04 AO3 整站维护（curl 回 418，浏览器里显示 "The archive is down for maintenance"）。恢复后下一篇公开作品，`EXTRA_EPUB=/path/x.epub npx vitest run test/epub-books.test.ts` 会打印章节和被跳过的条目，验完删文件 |

**文件**
- `src/epub/parse.ts`：解析（container → OPF → spine → NAV/NCX → 切章拆段）。`src/epub/drm.ts`：DRM 前两条。`src/epub/errors.ts`：`EpubError` + 提示语。`src/epub/import.ts`：sha256 去重、入库、`currentBookId()`。`src/epub/words.ts`：分词 `tokenize / wordAt / segments`。
- `src/components/ReaderView.svelte`：阅读视图（一次渲染一章）。`ParaText.svelte`：一段拆成词 span。`ImportButton.svelte`：文件选择器 + 进度条。`reading.svelte.ts`：阅读状态。
- `src/pages/ReaderPage.svelte` 只剩"没书 → 导入入口 / 有书 → 挂 ReaderView"。
- 测试：`test/epub.test.ts`（12 条，夹具用 `test/epub-fixture.ts` 现场 zipSync 拼）、`test/epub-books.test.ts`（真书，books/ 不在时自动跳过）。这两个文件头上有 `// @vitest-environment jsdom`（要 DOMParser），其余测试还是 node 环境。

**合同改动（只加不改）**
- `Settings` 加了 `readSize?: number`（px）、`readLeading?: number`（倍数），没设走 app.css 的默认值。没加 Dexie 表、没动 db.ts。

**切章规则**（`parse.ts` 文件头有全文）
- 章 = 目录（NAV，没有就 NCX）里的条目，按条目指向的锚点切，不按文件切（一个文件多章、一章多个文件都行）。
- 目录里有 ≥2 条像章节的（`Chapter …`、`1. …`、`IV. …`、Prologue/Epilogue）：第一条之前、最后一条之后的都算前置/后置页跳过，中间夹的非章节条目（比如 Interlude）保留。否则只按关键词跳（Cover、Contents、Copyright、Preface、Afterword、license、Project Gutenberg 等）。
- 切完 0 词的章丢掉（封面壳），章号按保留顺序重编。Gutenberg 的 `pg-boilerplate` 页眉页脚、页码（`pagenum`、`epub:type="pagebreak"`）在哪都剔掉。
- 章首的标题如果是目录标题的一部分（`Chapter I.<br/>PETER BREAKS THROUGH`）不收成段；其他小标题照收。`<br>` 变空格。
- 已知取舍：Oz 的 Introduction、AO3 的 Preface/Afterword（作者前言后记、标签）会被跳过。HP1 正式版的目录如果是 "CHAPTER ONE …" 也会走章节模式，到时候验一次 17 章。

**和 PLAN 不一样的地方**
1. **段落少于 50 不拒绝，只提示**："只拆出了 N 段。如果这本书本来很长，可能是加密了……"。AO3 短篇本来就不到 50 段，拒了第二内容源就废了。乱码（替换符/控制字符 >1%，或字母占比 <50%）照样拒。
2. **关掉了 CSS 断字**（`hyphens: manual`）：自动断字会把 romantic 拆成 ro-/mantic 跨两行，学英语时难认也难点（实测点词兜底就是被这个坑的）。
3. 阅读视图一次只渲染一章，章末"下一章"按钮。整本连续滚动要做虚拟列表，MVP 不值。
4. 多本书：没做书架，但目录面板里有"其他书"列表和"导入另一本"。当前书 = 进度更新时间最新的那本。同一文件重复导入不重新解析，只切过去。

**给 T3 / T4 的接口**
- 点词：阅读视图根元素冒泡派发 `CustomEvent('word-tap', { detail: { paraId, start, end, surface } })`（`bubbles + composed`，在 window/document 上都能听到）；也可以给 `ReaderView` 传 `onwordtap`。形状和 T3 在 types.ts 里写的 `WordTapDetail` 一样，T2 这边用的是 `components/reading.svelte.ts` 里同形状的 `WordTap`（为了不依赖 T3 没提交的类型）。
- 画标注：`ReaderView` 有两个 snippet 口子 —— `paraContent(p: ParaRow)` 换掉段内渲染（默认是 `<ParaText text={p.text} />`），`afterPara(p)` 在每段后面挂东西。段落元素是 `<p class="para" data-pid=…>`。**要求：段落元素里的文字必须等于 `para.text`**，否则偏移对不上；页边记号之类不属于正文的元素加 `data-nontext`，点词和偏移计算会跳过它。保留 `.w[data-s][data-e]` 词 span 最省事；不保留也行，点词会按坐标（`caretPositionFromPoint`）兜底。
- 可见段落：`import { reading } from '../components/reading.svelte'`，`reading.visibleParaIds`（屏幕上的段，按顺序）、`reading.topParaId`（最上面那段 = 进度）、`reading.bookId`、`reading.chapter`。T3 预取、T4 聊天上下文直接读。
- 换书/导入在 `src/epub/import.ts`：`importEpub(db, bytes, onProgress)`、`currentBookId(db)`、`touchProgress(db, bookId)`。
- 界面导航还是 App.svelte 里一个 `view` 变量。

**本地 headless 实测怎么跑**：`npm run build && npx vite preview --port 4173`，脚本在剧组 scratchpad（puppeteer-core + 本机 Chrome，没进项目依赖）。要点：Aa/目录面板是底部弹层，点遮罩要点上方空白处（点中心会点进目录）；断网测试要先等 `navigator.serviceWorker.ready` 再刷新一次让 SW 接管。

### T3（标注管线 + 词库）
- prompt 和 schema：`src/llm/prompts/annotate.ts`（`ANNOTATE_SYSTEM`、`ANNOTATE_USER_TEMPLATE`、`ANNOTATE_SCHEMA`、`TAP_SCHEMA`、`ANNOTATE_PROMPT_VERSION`）。和 PLAN 3.1 逐字一致；点词补注的 system 短版 PLAN 没出全文，T3 自己写。
- 调用：
  ```ts
  const c = await getClient(settings.appToken);
  const p = baseParams('annotate', settings);
  const msg = await c.messages.create({
    ...p,
    system: [{ type: 'text', text: ANNOTATE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }],
    output_config: { ...p.output_config, format: { type: 'json_schema', schema: ANNOTATE_SCHEMA } },
  });
  ```
  模型、effort、max_tokens 在 `src/llm/roles.ts`，别在业务代码里写死。用户在设置里改的模型通过 `settings.models` 覆盖（`modelFor()` 会过滤掉白名单外的）。
- 模型输出的形状是 `AnnotationItem`（snake_case，和 JSON 一致）；锚定成功后存 `Annotation`（camelCase + start/end）进 `db().annotations`。chunk 状态在 `db().chunks`（`[bookId+status]` 索引可查待办）。
- 词库：`db().words`，主键 lemma。账本：`db().ledger`。
- 读者水平和防剧透在 `settings`（`src/settings.svelte.ts`），存库前 `$state.snapshot`。

### T4（小克抽屉）先知道的
- `src/llm/prompts/chat.ts` 有 `CHAT_SYSTEM` 和英文模式的中途 system 消息 `CHAT_EN_MODE`。聊天走 `c.beta.messages.stream({ ...betaParams('chat', settings), ... })`，已经带好服务器端 fallback。

## 本地测页面的小技巧

- Chrome headless 的 `--dump-dom` 一次性模式里 IndexedDB 会卡住，页面会停在只有标题的状态（不是代码问题）。要看真实渲染，用 `--remote-debugging-port` 开正常会话再用 CDP 取 `document.body.innerText`。
- 换了构建后浏览器还在用旧版，是 service worker 的 prompt 模式在等确认：点横条，或用干净的浏览器配置。

## 已知小事

- `npm audit` 报 11 个 low/moderate，全在构建工具链（workbox-build、glob、ejs 等），运行时依赖 0 个。等 vite-plugin-pwa 升级再说。
- 图标是脚本画的占位（米色底 + 一本摊开的书），好不好看她说了算，替换 `public/icon-192.png` / `icon-512.png` 即可。
- TypeScript 用 6.0.3 不是最新的 7.0：svelte-check 只支持到 TS 6。
