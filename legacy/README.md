# legacy/：代理方案存档（不参与构建、不跑测试）

2026-11-04 她定：不要代理、不要托管后端，改成 pocketverse 同款"设置页本地填 key、浏览器直连 Anthropic"，静态部署到 GitHub Pages（PLAN 2.6 / 2.7）。

这里留着原来的 Cloudflare Pages Function 代理，万一以后要给别人用（不想把 key 交到别人手机上）可以捡回来：

- `functions/api/anthropic/[[path]].ts`：口令 → 真 key、白名单、流式透传
- `proxy.test.ts`：代理单测（引用的 `PROXY_BAD_TOKEN` 已从 src/llm/client.ts 删掉，捡回来时要补）
- `wrangler.toml`：Pages 项目配置

白名单逻辑已经搬到 `src/llm/roles.ts`（`checkBody` / `badBetas` / `checkRequest`），捡回来时两边保持一致。
tsconfig 和 vitest 都不包含 legacy/。
