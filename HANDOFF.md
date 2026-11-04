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

### T2（EPUB 导入 + 阅读器）
- 产出：`ParaRow`（= `Para` + `bookId`）写进 `db().paras`，`ChapterRow` 写进 `db().chapters`，`Book` 写进 `db().books`（id = 文件 sha256）。
- 段落编号用 `paraId(chapter, idx)` 生成（`c03p0012`），反解用 `parseParaId`。章号、段号都从 1 开始。排序用 `[chapter, idx]`，别按字符串排（超过 99 章时会乱）。
- 按章读段：`chapterParas(db(), bookId, n)`（走 `[bookId+chapter+idx]` 索引，已排好序）。
- 阅读进度写 `db().progress`（主键 bookId）。
- 入口：`src/pages/ReaderPage.svelte` 现在是空壳，导入按钮、阅读视图从这里长出来。排版变量在 `src/app.css` 的 `--read-size / --read-leading / --para-gap`。
- 要装 fflate（`npm i fflate`）。测试用 EPUB 在测试代码里用 `zipSync` 现场拼（`.gitignore` 有 `*.epub`）；Peter Pan / Oz 在 books/，只读。
- 界面导航现在是 App.svelte 里一个 `view` 变量，页面多了可以换成别的方式。

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
