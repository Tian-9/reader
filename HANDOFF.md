# HANDOFF

## 当前状态（2026-11-04，T1–T5 完成，直连模式，已上线 https://tian-9.github.io/reader/；首用反馈已修，见"首用反馈 2026-11-04"一节；朗读/发音已加，见"朗读 / 发音 2026-11-04"一节）

T1 骨架、T2 导入+阅读、T3 标注+词库、T4 小克抽屉+前情摘要、T5 生词导出+备份+花费面板都在本地跑通。MVP 的代码部分到此齐了。
**2026-11-04 她定：不要代理、不要托管后端，改成 pocketverse 同款"设置页本地填 key、浏览器直连 Anthropic"，静态部署到 GitHub Pages。** 已改完并真跑验过，见下面"直连模式"一节；代理代码存档在 `legacy/`。
**还差什么才能给她用，看最后一节"收口清单"。**
本机真跑 key 在 `~/.config/reader/key`（2026-11-04 她给的），`bash scripts/real-all.sh` 自动读；真跑结果见 T3/T4 段的"真跑"小节。

**2026-11-04 她定的改动**：去掉地域人设（"都柏林人怎么说"之类），先普通聊。标注/点词/小克三个 prompt 删掉了住在都柏林、爱尔兰用法相关的句子，fun_type「爱尔兰/方言」改成「方言/口音」，三个 PROMPT_VERSION 各 +1（已标过的组读到时会重标）。PLAN 3.1/3.2 同步，`test/prompts.test.ts` 现在逐字核对 prompt 和 PLAN。提交 `9f5f385`。

### T1（骨架 + 代理）

#### T1 验收结果

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

#### T1 和 PLAN 不一样的地方（都是补，不是改方向）

1. **代理也认 `Authorization: Bearer` 口令。** PLAN 2.6 写的是 `x-api-key`，但 `@anthropic-ai/sdk` 1.x（2026-10-21 发布的新大版本）把 apiKey 一律放在 `Authorization: Bearer` 里发。不补的话前端所有请求都会 401。两个头都不转发上游。
2. **代理多拦了三样：** `fallbacks` 只放行 `"default"`（数组形式能指定任意模型，等于绕过白名单）；`speed: "fast"`（贵一倍）；请求体超过 256KB → 413。请求头只转发 content-type / anthropic-version / accept / anthropic-beta，其余（cookie、浏览器直连标记、SDK 遥测头）全丢。
3. **Dexie 多了两张表：** `chapters`（存目录标题，PLAN 2.4(b) 没列）和 `settings`。`ledger` 加了可选的 `bookId`（"这本书花了多少"要按书分）。
4. **SDK 懒加载**：首屏只有 Dexie + Svelte（gzip 约 50KB），SDK（gzip 约 80KB）第一次调 API 才下载，service worker 照样预缓存，离线不受影响。
5. **设置页有个"测一下口令"按钮**：发一句最短的 Haiku 请求（< $0.0001）。能分清"口令不对"和"口令对了但服务器上的 key 被 Anthropic 拒了"。

## 首用反馈 2026-11-04

她第一次在手机上用（HP1 第 1 章，B1）。四处要修 + 一个疑问，全部做完、真跑/headless 验过、已推 main 部署。

### 1. 标注质量：`country`（常用词）、`Potter`（人名）被划了虚线

**查了什么**
- 原过滤 `isVisible` 只信模型给的 level，另外有三条不看 level 的旁路：vocab 的 `level === '-'`（schema 的 level 枚举里**没有 A1**，模型想说"很简单"只能填 A2 或 "-"，填 "-" 就直接显示）、`invented=true`、词库里 unknown/learning 的词（**点开过一次卡片就自动记 unknown**，之后全书不看等级都显示）。
- 彼得潘第 1 章真跑（`shots/fix1-data/report.json`，Haiku，B1）：入库 84 条（vocab 70、fun 14）。**Haiku 的 level 分布 B2 35 / C1 22 / C2 11 / B1 1 / A2 1，不离谱**；旧过滤显示 68 个 vocab，里面在整张 NGSL（2809 个高频词）里的只有 6 个（charge #498、air #542、dismiss #2392、intensely #2564、peer #2007、entrancing→entrance #2225），在 B1 档（前 2000）里的只有 charge、air 两个；大写开头的只有 `Brussels sprout`、`I daresay`，**0 个人名**。旧 t3 报告（第 1/5/12 章，Haiku 41 条 + Sonnet 57 条）同样 0 个人名，B1 档常用词只有 Sonnet 的 remain、conduct。
- 结论：**彼得潘上复现不出来**；本机没有 HP（books/ 里只有彼得潘和绿野仙踪），她手机上的库也看不到，所以 country/Potter 具体走的哪条路**没法确认**。最可能的两条：① HP 的用词比彼得潘浅，模型凑数时给了 "-" 或高估 level；② 她点开过这两个词（或误触），被记成 unknown 后不看等级常显示。两道闸把这几条路全堵上了（唯一没堵的是模型把人名标成 `invented=true`，按任务书 invented 的不拦，因为 Muggle 这类自造词也是句中大写）。

**修法（不信模型，两道硬闸，在 `src/annotate/visible.ts`）**
- 常用词闸：内置 NGSL 1.2（New General Service List，Browne/Culligan/Phillips，**CC BY-SA 4.0**，可放公开仓，文件头署名）→ `src/annotate/common-words.ts`（29KB：2809 个按频率排的 lemma + 50 个星期月份数字 + 518 个不规则词形/英式拼写映射）。按水平切档：A1 前 500、A2 前 1000、**B1 前 2000**、B2 及以上整张表。查表会试英式→美式（colour、centre、realise…）、常见词尾（countries、stopped、carefully）、不规则形（children、went）；quote 是单个词时也按 quote 查（防 lemma 写成短语）。Oxford 3000 是牛津的版权材料，没用。
- 专有名词闸：quote 首字母大写、不在句首、`invented=false` → 不显示。句首 = 段首，或 . ! ? … : 后面，或紧跟开引号；`Mr.`/`Mrs.` 这类称谓的句点不算句尾。单独的 I、带小写词的短语（Brussels sprout）放行。
- 被闸住的：存库留着，标 `hiddenReason: 'common' | 'proper'`（types.ts 只加字段，Dexie 不用升版本）；不划线、点开卡片照出但**不记进词库**、不导出、不进 `<known>`/`<unknown>` 样本（省 token）。她自己点了"加入生词本"的词能越过两道闸。显示时按**当前水平现算**，所以她手机上已经标过的 HP 第 1 章**不用重标**，新版一开就生效。
- 生效位置：`isVisible`（标注层 + t3 脚本）、`processItems`/`tapAnnotate`（入库打标记）、`knownSample`/`unknownSample`、`buildVocabExport(d, level)`。

**真跑（`node scripts/vrun.mjs scripts/fix1-real.ts`，彼得潘第 1 章 4 组，$0.011，4 次调用）**：过滤前显示 68 个 vocab → 过滤后 66 个，滤掉 2 个：
| quote | lemma | 模型给的 level | 原因 | NGSL 排名 |
|---|---|---|---|---|
| her charges | charge | C2 | common | #498 |
| beautifully aired | air | B2 | common | #542 |

这两个都是**常用词的冷门义项**（"她看护的孩子们"、"晾好通风"），是频率表闸的代价：词频看的是词不是义项。她点那个词卡片照出，只是不划线。另一个已知的小误伤：`entrancing` 会被词尾规则当成 `entrance`（#2225），只影响 B2 及以上档。

### 2. "标注中…"小牌子
`Annotator.ensureAround(bookId, paraId, onPending)` 每标好一组报一次"k、k+1 里还没好的组"；`pillState(pending, 屏幕上的段落)`：还没好的组里有屏幕上的段落 → "标注中…"；只差屏幕外的下一组 → 右下角不打扰的"预取下一段"小字（11px、无边框、半透明）；都好了不显示。快速翻页时只认最新一次回报。

### 3. 右下角"下一章"和"小克"叠在一起
"下一章"本来就在章末正文流里，问题是页面底部只留了 3em，滚到底时它正好停在固定的"小克"按钮（离底 52px、高 44px）底下。改成章末导航下面留 `120px + 安全区`，滚到底时"下一章"停在"小克"上方。390px headless 量出来：下一章底边 708、小克顶边 748，**间隔 40px、不相交**（`shots/fix1-reading.png`）。

### 4. 本章生词
目录面板加了"目录 | 本章生词 N"两个页签。本章生词 = 本章当前显示的 vocab（过了两道闸和阈值），按出现顺序（段落序号 → 段内位置），同 lemma 留第一处，每条 lemma + 中文释义；点一条 → 关面板、滚到那段、那个词用卡片高亮色闪 1.6 秒。标注层通过 `reading.chapterVocab` 发布列表（`reading.svelte.ts`），`FOCUS_ANNOTATION_EVENT` 触发闪一下。截图 `shots/fix1-wordlist.png`。

### 另查：正文里的 "Dudley. … He"
`src/epub/parse.ts` **不会**插省略号：`cleanText` 只做 NFC + 去零宽字符 + 合并空白（NFC 不会把 `...` 变成 `…`），拼段只拼原文文字、`<br>` 变空格、丢掉的元素（图片、页码）不补任何字符。**应为她文件原有**（HP1 这句本来就有一处省略号，美版排成 `. . . .`）。
顺带查出并修了一个 T2 的小毛病：段中间带 id 的行内元素（页码锚点 `<span id="page12"/>`、`epub:type="pagebreak"`）会把一段**切成两段**（本意是在目录指向的章节锚点处切章，但没判断这个 id 是不是目录指向的）。现在只有目录真指向的锚点才切。她手机上已导入的书不受影响（要重新导入才按新规则拆段）。单测在 `test/epub.test.ts` 末尾。

### 验收
| 项 | 结果 |
|---|---|
| `npm run lint` / `npm run build` | 过（0 错 0 警告；136 个单测 + 1 个跳过，新增 `test/gates.test.ts` 22 条 + epub 1 条） |
| 单测覆盖 | 词表形状/大小/切档、country 和英式拼写/词形、句首判断、人名闸和例外、isVisible 两道闸 + learning 越过 + "-" level、入库打 hiddenReason、样本排除常用词、点词补注不记词库、导出不导常用词、pillState 四种情况、ensureAround 回报序列、本章生词排序去重、解析器不插省略号不切段 |
| headless 390px（`node scripts/fix1-browser.mjs`，假 API） | 11/11 过：标注中… → 预取下一段 → 消失；塞进去的 B2 常用词（children）和句中人名（Wendy）不划线；章末按钮间隔 40px；本章生词 11 条不含被闸的词；点一条跳过去；0 报错。报告 `shots/fix1-data/browser.json` |
| 真跑 | 见上，$0.011（上限 $0.3） |
| 推 main → 线上 | 提交 `0b40791` 推 main，Actions「Deploy to GitHub Pages」成功；线上 `index.html` 的主包从 `index-7J0tw1uT.js` 变成 `index-BVJ7xlKp.js`，新包里有"本章生词""预取下一段"，首页 200。她手机上是 service worker 的 prompt 模式：打开后出"有新版本"横条，点了才切 |

**没改的**：模型选择（Haiku/Sonnet 她还没定）、prompt（`ANNOTATE_PROMPT_VERSION` 没动，不触发重标）、books/。

**她可以看/定的**：常用词闸的档位（B1 = 前 2000）会不会藏多了——读几章要是觉得"这个我其实不认识但没划线"，告诉剧组调 `COMMON_TIER`；或者直接点那个词、卡片上"加入生词本"，以后它全书都划线。

## 朗读 / 发音 2026-11-04

她要的：读得慢，想 (a) 点单词听发音 (b) 整段朗读跟着听、练按说话速度理解。用浏览器自带的 Web Speech API（`window.speechSynthesis`，手机系统的文字转语音），不调付费 API、不加第三方脚本（CSP 不动）。

**三个入口**
1. **单词卡片右上角 🔊**（`WordCard.svelte`，`data-testid=say-word`）：读她点中的那几个字（surface / quote），**不读 lemma**——眼前是 went 就该听 went，lemma 是词典原形、短语 lemma（give a start）读出来和正文对不上。整段朗读中按它：先暂停整段、读完这个词自动接着读。
2. **每段左页边一个淡的小 ▶**（`ReaderView.svelte` 的 `.say`，落在 main 的 16px 左边距里）：从这段开始**连续往下读到章末**。正在读的段浅色底（`.para.speaking`），段落换了视图跟着滚（段首顶到朗读条下面）。工具条下面出一条 sticky 的**朗读条**：「朗读中 · 1.0x ｜ 暂停 ｜ 停止」，倍速按钮点一下轮换 0.8 / 1.0 / 1.2（当前句按新倍速重念）。标注虚线、点词卡片、※ 在朗读时照常能用。
3. **设置页「朗读」一节**：声音下拉（只列英文声音，按优先级排；"自动"项显示现在会用哪个）+ 整段朗读默认倍速。存 `settings.voiceURI` / `settings.speechRate`（可选字段，备份照常带）。

**实现（`src/speech/`）**
- `voices.ts`（纯函数）：`pickVoice` 优先级 = 设置指定的 > **en-GB 的 Google 声音**（安卓 Chrome 上叫 "Google UK English Female/Male"）> 任何 en-GB > 任何 en-*（Google 优先）；lang 兼容 `en_GB` 写法。`splitSentences`：按句末标点切，Mr./Mrs./Dr. 后不断，短句凑到 ≤200 字符，超长句按逗号再按空格切。
- `speech.svelte.ts`：`createSpeech(env)` 工厂（单测注入假 synth）+ 浏览器默认实例 `speech`（$state：supported / status idle|speaking|paused / paraId / rate / voices / voiceName）。每次 speak 前 `cancel()`；整段 = 逐句 utterance 用 onend 串，gen 计数器让 cancel 之后迟到的 onend/onerror 作废；**暂停 = 记住段+句 → cancel，继续时重念那句**（不用安卓上不靠谱的原生 pause/resume）；合成出错（不是 interrupted）跳过这句继续；`visibilitychange` 隐藏 → stop；换章（`openChapter`）、切书/去设置页（ReaderView `onDestroy`）→ stop。`getVoices()` 先空、听 `voiceschanged` 补；进设置页和每次 speak 前再刷一次。
- 不支持 speechSynthesis 的浏览器：`speech.supported=false`，🔊、▶ 都不渲染，设置页写一句"这个浏览器不支持朗读"。
- 一切朗读都由点击触发（安卓 Chrome 要手势才出声），没有自动播。

**踩的坑**：▶ 按钮放进 `<p class="para">` 时，Svelte 把按钮和后面 `{#if}` 之间的换行保留成一个空格文本节点，段内文字比 `para.text` 多一个前导空格，标注高亮整体错一位（`" delightfu"`）。改成 `<p>` 内标记写在一行、按钮是空元素（字形用 CSS `content` 画）+ `data-nontext`。已记进 CLAUDE.md。

**验收**
| 项 | 结果 |
|---|---|
| `npm run lint` / `npm run build` | 过（0 错 0 警告；**162 个单测 + 1 跳过**，新增 `test/speech.test.ts` 26 条） |
| 单测覆盖（假 speechSynthesis） | 选声音 6 种情况（Google en-GB > en-GB > en-* > null、指定 voiceURI、下拉排序）；切句 5 种；引擎：不支持环境不报错、voiceschanged 异步补声音、读词先 cancel 再 speak、没英文声音 lang 兜底 en-GB、整段逐句串行 + 跳空段 + 章末停、长段 ≤200 切多条顺序不乱、从中间段开始、id 不存在不开始、stop 后迟到的 onend 作废、暂停/继续重念当前句、倍速轮换 + 重念、朗读中读词自动接着读、暂停中读词不恢复、合成出错跳句、设置指定声音 |
| headless 390px（`node scripts/speech-browser.mjs`，假 API + 假 speechSynthesis） | **17/17 过**：导入 52 段每段有空 ▶ → 点 delightful 出卡片有 🔊 → 🔊 先 cancel 再 speak("delightful")、Google UK English Female、en-GB → ▶ 开始：朗读条"朗读中 · 1.0x"、段高亮、第一条 utterance 是段首 ≤200 字符 → 视图滚到该段 → 朗读中点词卡片照开、🔊 先暂停读词再自动继续 → 高亮跳到下一段且在屏幕内 → 1.2x 重念 → 暂停（cancel、不再 speak、高亮保留）/ 继续 → 停止（条消失、高亮清掉）→ 最后一段读完自动停 → 朗读中去设置页停 → 设置页下拉 4 个英文声音按优先级、无中文声音、自动项写着 Female → 选 Male + 1.2x 保存入库 → 回阅读页再读用 Male、1.2x → 0 报错。截图 `shots/speech-card.png`、`speech-reading.png`、`speech-settings.png`，明细 `shots/speech-data/browser.json` |
| 回归 | `t4-browser.mjs` 10/10、`fix1-browser.mjs` 11/11、`t5-browser.mjs` 全过 |

**她手机上会怎样（没真机验，按安卓 Chrome 的行为推）**：装了"Google 文字转语音"（Pixel 等大多数安卓出厂自带）时 getVoices 里有 "Google UK English Female"，自动就选它；英语语音包没下载过的话第一次念可能要联网下载一下包（系统行为）。一个英文声音都没有 → utterance 只带 `lang=en-GB` 交给系统，可能用默认声音硬念或**没声音**，设置页"自动"项会显示"还没找到英文声音"，按钮照样在（不能提前知道系统会不会出声）。PWA 全屏模式、息屏/切后台会 stop（visibilitychange），不做后台播放。

## 直连模式 + GitHub Pages（2026-11-04 改）

PLAN 2.6 / 2.7 已改写（原方案存档在两节末尾）。

**改了什么**
- `src/llm/client.ts`：`new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', dangerouslyAllowBrowser: true, defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' }, fetch: guardedFetch })`。`guardedFetch` 每个请求发出前过 `roles.ts` 的 `checkRequest`（原代理的路径/方法/查询参数/beta 头/体积/模型/max_tokens/fallbacks/fast mode 检查原样搬过来），不过的本地回 400、请求不出浏览器。`NoTokenError` → `NoKeyError`。
- `Settings.apiKey`（新字段）存 Dexie settings 表（= pocketverse 的存法：IndexedDB，和其他设置一起）。`appToken` 改成可选的遗留字段，`normalizeSettings` 读到就扔。备份不带 apiKey / appToken，导入保留本机 key；`validate-export.mjs` 见到这两个字段判不过。
- 设置页：「应用口令」换成「Anthropic API key」密码框（有"显示"），"测一下"先保存再直连 ping，分得清 401（key 不对）/ 403（没权限）/ 断网。
- `vite.config.ts`：`base: '/reader/'`；manifest `id / scope / start_url = /reader/`；workbox `navigateFallback: 'index.html'`（相对 sw.js）；`cspMeta()` 插件只在 build 时往 `<head>` 最前面注入 CSP meta：`default-src 'self'; connect-src 'self' https://api.anthropic.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'`。`__BUILD__` 在 CI 上带 commit 短 hash。
- `index.html`：`<meta name="robots" content="noindex, nofollow">`，图标用 `%BASE_URL%`。`public/_headers` 删了（GitHub Pages 不认）。
- `.github/workflows/pages.yml`（推 main → lint → build → upload-pages-artifact → deploy-pages）+ `ci.yml`（非 main 分支跑 lint + build），和 pocketverse 同一套。
- 代理 `functions/`、`wrangler.toml`、`proxy.test.ts` → `legacy/`（有 README），tsconfig / vitest 不含它。`package.json` 删了 `proxy:dev`，`preview` 固定 4173 端口。
- 单测：新 `test/direct.test.ts`（代理的限额用例搬过来 + 真 SDK 打桩验：地址是 api.anthropic.com/v1/messages、带直连头、key 在请求头、白名单外的请求不发网络、401 文案）；`test/roles.test.ts` 改成核对 roles.ts 自己的白名单，并加了"每个用途 × 每个模型的 baseParams/betaParams 都过 checkBody"。
- `t4-browser.mjs` / `t5-browser.mjs`：拦截目标从 `/api/anthropic/*` 改成 `https://api.anthropic.com/*`（假回复带 CORS 头），默认地址 `http://localhost:4173/reader/`。
- 测试和脚本里的假 key 一律不用 Anthropic key 的前缀（公开仓库要能用 `git log --all -p | grep -cE 'sk-an[t]'` = 0 做闸门）。
- **历史重写过一次（2026-11-04，推 GitHub 之前）**：T1 的 package.json `proxy:dev` 里有一串带 Anthropic key 前缀的假值（不是真 key），为了让上面的闸门是 0，用 `git filter-branch` 把它换成 `fake-key-for-local-tests`，所有提交 hash 都变了（本文件里引用的已改成新的）。重写前的完整仓库打包在剧组 scratchpad 的 `reader-before-rewrite.bundle`（会话临时目录，不长期保留）。

**验收（真请求）**：`node scripts/direct-browser.mjs`（`npm run preview` 的 `/reader/` 下，真 SW、真 CSP、key 从 `~/.config/reader/key` 用 CDP 打进密码框，不打印；临时 Chrome 配置跑完即删）—— **11/11 过**：

| 项 | 结果 |
|---|---|
| `npm run lint` / `npm run build` | 过（0 错 0 警告；113 个单测 + 1 个跳过） |
| CSP meta、noindex | 都在，CSP 和上面一字不差 |
| manifest（加到主屏幕用） | `/reader/manifest.webmanifest` 能取，scope / start_url / id = `/reader/`，standalone，3 个图标都 200，Chrome 解析 0 错误 |
| service worker | 注册在 `/reader/sw.js`，scope `/reader/`，刷新后接管页面 |
| 断网刷新 | 能打开 |
| 设置页填 key → 测一下 | "通了（claude-haiku-5-5）"；IndexedDB 里存了 apiKey、没有 appToken；输入框是 password |
| 导入彼得潘 → 真标注 | 52 段，真标注回来 26 处生词虚线 + 4 个 ※ |
| 浏览器直连 | 预检 OPTIONS 200 + 两次 POST 200，`access-control-allow-origin: *`；没连任何别的第三方；0 次 CSP 违规、0 个页面报错 |
| 花费 | $0.0042（1 组标注；ping 不记账，< $0.0001） |
| 截图 390px | `shots/direct-settings.png`（设置页，测一下成功）、`shots/direct-annotate.png`（真标注） |
| 回归（假 API） | `t4-browser.mjs` 10/10、`t5-browser.mjs` 全过（都在 `/reader/` 子路径 + 直连下） |

## 待她做（剧组不碰）—— 代理时代的，直连后作废，留着备查

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

## 各 T 的交接（T2 / T3 / T4）

**共享接口全在 `src/types.ts`，Dexie 表在 `src/db/db.ts`。** 两边并行时只认这两个文件；要改字段先改这里，再通知另一边。

### T2（EPUB 导入 + 阅读器）—— 2026-11-04 完成，未部署

提交：`d218a21`（加 fflate、jsdom）、`4a793c9`（T2 本体）。

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

### T3（标注管线 + 词库）—— 2026-11-04 完成（真跑已补），未部署

**真跑（2026-11-04 补跑，去人设后的 prompt v2）**：第 1 章 4 组 84 条，锚定 83 条（**98.8%**），丢的 1 条是 quote 超 5 词被守卫拦；入库 quote **0 条超 5 词**；anchorFail / occFallback / 拒绝重试都是 0。"我会"（pluck）→ 全书不再显示，第 5、12 章请求的 `<known>` 里都有它。回看第 1 章 **0 次调用**。Haiku 6 组 $0.0148、Sonnet 对照 3 组 $0.088。截图 `shots/t3-ch{1,5,12}.png` + `-sonnet.png`，报告 `shots/t3-data/report.json`（`compare` 里是两边的 fun/vocab 条目原文，**好不好她看图拍板**）。
第一次真跑撞到截断：Haiku 的 adaptive thinking 一组吃 4.3–5.6K token，原来 max_tokens 6000 不够，JSON 写到一半被切。已修（见 `9f5f385`：上限放宽 + 截断时 effort=low 重发一次），最终这趟 0 次重发。

（以下是当时没 key 时的说明，留着备查）脚本已备好，并用假模型（`--mock`）把整条链路跑通过一遍（第 1 章切组 → 标注 → "我会" → 后续请求带 `<known>` → 回看 0 调用 → Sonnet 对照 → 静态 HTML → 390px 截图）。有 key 后一条命令：
```
ANTHROPIC_API_KEY=… node scripts/vrun.mjs scripts/t3-real.ts      # 结果：shots/t3-ch{1,5,12}.png（+ -sonnet 对照）、shots/t3-data/report.json
```
脚本直连 Anthropic（不走代理），不打印 key；累计花费超 `--budget`（默认 $2）自动停并写半截报告。预估这一趟 < $0.2（Haiku 6 组约 $0.01，Sonnet 3 组约 $0.1）。

**验收结果**

| 项 | 结果 |
|---|---|
| 单测（全自编段落） | 锚定：弯/直引号双向、大小写空格、首尾标点、occ 第 1/2/3 次、词边界（"art" 不进 "start"）、occ 超出退回第一次、找不到、6 词 quote；守卫：5 词放行 6 词拦、8 词重合替换"（原文略）"、7 词不拦、弯撇号大小写；分组；管线请求形状；Haiku 拒绝 → Sonnet 重试；预取 k/k+1/k+2、跨章、去重、`<already_noted>`；"我会"全书生效 + 下一次 `<known>` 含该词；阈值过滤；连点 15 次提示；点词补注。 |
| `npm run lint` / `npm run build` | 通过（0 错 0 警告，82 个单测 + T2 的 1 个跳过） |
| 渲染层（真 Chrome，`scripts/t3-demo`，用 T2 的 `ParaText` + `data-pid` 段落） | B1 读者 6 个生词显示 5 个（B1 的那个被阈值藏掉）、2 个页边 ※；点 sideways 开卡片并高亮；点"这个我会"→ 两处 sideways（不同段）一起消失，0 次调用；点没标的 grumbled → 1 次补注调用、多一条虚线；※ 打开"有意思"卡片；"问小克"把 `ask-xiaoke` 冒泡到 window。页面 0 报错 |
| 真跑彼得潘第 1 章：锚定率 ≥90%、入库 quote 无 >5 词、花费 | 过：98.8%（83/84），0 条 >5 词，第 1 章 4 组 $0.010 |
| "我会"全书生效 + 下次 `<known>` 含该词（打日志） | 单测 + demo 已验；真跑那一步脚本也会记 `knownLog` |
| 回看已标章节 0 次调用 | 单测已验（同一标注器、新开标注器都是 0）；真跑脚本会再数一遍 |
| 第 1/5/12 章各一组截图 + Haiku/Sonnet fun 并排 | 已出：`shots/t3-ch{1,5,12}.png`、`shots/t3-ch{1,5,12}-sonnet.png`；fun 条数 Haiku 4/5/4、Sonnet 4/6/1，vocab 条数 Haiku 17/12/12、Sonnet 22/16/19。**待她看图拍板** |

**文件**
- `src/annotate/`：`text.ts`（规范化 + 位置映射、词数）、`anchor.ts`（锚定）、`guard.ts`（输出守卫）、`chunker.ts`（分组 + 存 chunks）、`profile.ts`（拼 user 消息：known 60 / unknown 40 / 前情 / already_noted / passage）、`pipeline.ts`（调用 + 拒绝重试 + 锚定 + 守卫 + 入库 + 记账）、`queue.ts`（预取队列 `Annotator`、浏览器用的 `getAnnotator()`）、`tap.ts`（点词补注）、`words.ts`（词库三态、阈值提示）、`visible.ts`（显示过滤）。
- `src/llm/pricing.ts`（PLAN 第 6 节单价；缓存写 = 输入 × 1.25）、`src/llm/ledger.ts`（`recordUsage` / `totalUsd`，T4/T5 照用）、`src/llm/prompts/tap.ts`（点词短 system，`TAP_PROMPT_VERSION`）。
- `src/components/AnnotationLayer.svelte`（标注层）、`WordCard.svelte`（底部卡片）。
- `scripts/vrun.mjs`（用 vite 跑 TS 脚本）、`scripts/t3-real.ts`（真跑）、`scripts/t3-epub.ts`（临时 EPUB 抽段，只认 Gutenberg 结构）、`scripts/t3-shot.mjs`（CDP 整页截图，不依赖 puppeteer）、`scripts/t3-demo/`（标注层 demo：`npx vite --config scripts/t3-demo/vite.config.mjs`，端口 5287）。都不进 dist。
- 测试：`test/anchor|guard|chunker|pipeline|tap|pricing.test.ts`，夹具 `test/fixtures/t3.ts`（自编段落）。

**合同改动（只加不改）**
- `types.ts`：`ChunkRow.stats?: ChunkStats`（每组的锚定/守卫统计）；`Word.level?`（挑 known 样本、判断同级连点）；新类型 `GuardEvent`、`WordTapDetail`（= T2 的 `WordTap`）、`AskXiaokeDetail`。
- `db.ts`：`version(2)` 加表 `guardEvents`（`++id, ts, bookId, kind`），v1 没动。守卫/锚定失败/拒绝每次记一行，只记"发生了什么"不存原文；T4 的聊天守卫也往这里记（purpose='chat'）。

**接进 App**（T3 当时不改 T2 的文件，T4 已按下面这行接上）：`AnnotationLayer` 已经按 T2 的接口写好，谁接手 ReaderView 时加一行就亮：
```svelte
<!-- ReaderView 里，包住所有 <p class="para" data-pid> 的那个元素内部 -->
<AnnotationLayer {bookId} root={那个元素} paraIds={本章段落 id 数组} currentParaId={reading.topParaId} />
```
- 它不改段落 DOM：生词虚线用 CSS Custom Highlight API（浏览器自带的"给一段文字上样式而不插标签"，安卓 Chrome 105+ 支持）画在 T2 的文字上；※ 画在段落外的绝对定位浮层里（浮层相对最近的定位祖先，坐标按自己算，不要求 root 有 position）。
- 点词听 window 上的 `word-tap`；点到已标的词（包括被"我会"藏起来的）开卡片、0 调用，没标的走点词补注。
- `currentParaId` 变了 300ms 后预取：等 k、k+1，后台 k+2；已标好的组连 SDK 都不加载。右下角有个"标注中…"小牌子，失败（比如没填口令）出提示条。
- "问小克"只派发 `CustomEvent('ask-xiaoke', { detail: AskXiaokeDetail, bubbles, composed })`，T4 在 window 上听。

**和 PLAN 不一样 / PLAN 没写死的地方**
1. **组不跨章**：chunk 只在一章内攒（`<already_noted>` 和前情都按章算）。章尾 <300 词的尾巴并进前一组（合起来 ≤1000 词），否则两组在段落边界上对半分。彼得潘第 1 章 3033 词切 4 组。预取的 k+1/k+2 可以跨到下一章。
2. **occ 对不上**（模型数错第几次）：退回第一次出现，算锚定成功，单独计 `occFallback`。quote 带首尾标点找不到时去掉标点再找一次。
3. **重合守卫**按"本组所有段落"建 8 词片段索引，扫 `lemma / gloss_zh / note_zh` 三个字段；只把重合那段换成"（原文略）"，前后中文保留。
4. **同一个 prompt 版本标过就不再请求**；`ANNOTATE_PROMPT_VERSION` 递增后，读到时会重标并先删掉这组旧标注（点词补注的 `chunkId='tap'` 不受影响）。
5. **阈值 = 设置里的水平自评**（B1 → 显示 B2 及以上）。在词库里标过"不认识/在学"的词、作者自造词、fun 条目不受阈值限制。卡片上已"我会"的词显示"其实还不熟"可以撤回。
6. **连点提示**：最近一串"我会"同一级、每满 15 次提示一回"要不要把水平调到 X"，点"调到 X"才改设置（她点才改，不自动改）。
7. **`<known>` 样本**：最近 10 个无条件保留（保证刚点的"我会"一定在下一次请求里），其余从最近 200 个里按离阈值的级距挑，凑满 60。
8. **点词补注**的 system 不到 512 token，达不到缓存下限，所以不打缓存断点。补注结果存成 `chunkId='tap'` 的 vocab 标注 + 词库记 unknown/tapped。
9. 真跑用的是我自己的临时抽段脚本（正则取 `<p>`），不是 T2 的解析器；第 1 章我这边 52 段，和 T2 的切法可能有一两段出入（T2 会剔掉章首标题），不影响标注验收。

### T4（小克抽屉 + 前情摘要 + 接线）—— 2026-11-04 完成（真跑已补），未部署

**真跑（2026-11-04 补跑）**：9/9 过，$0.045（5 轮 Sonnet 聊天 $0.036 + 2 章摘要）。回答原文在 `shots/t4-data/report.json` 的 `turns`，防剧透/英文模式/念原文的表现**她看原话判断**。

（以下是当时没 key 时的说明，留着备查）有 key 后（放 shell 或 `~/.config/reader/.env` 里写 `ANTHROPIC_API_KEY=…`）：
```
bash scripts/real-all.sh          # 顺序跑 t3-real（≤$1.5）+ t4-real（≤$0.5），合计 ≤ $2；不打印 key
```
单跑 T4：`node scripts/vrun.mjs scripts/t4-real.ts`，报告 `shots/t4-data/report.json`（`checks` 每条过/不过 + 每轮的原话回复、usage、花费）。预估 T4 这一趟 < $0.2（Sonnet 5 轮 + Haiku 摘要 8 次）。

**A. 接线**
- `ReaderView` 的 `<article>` 里挂了 `<AnnotationLayer {bookId} root={article} paraIds currentParaId={reading.topParaId} />`（就是 T3 说的那一行）。article 加了 `position: relative`（※ 浮层的定位基准）和 `padding-right: 14px`（※ 不伸出屏幕，见下面"和 PLAN 不一样"第 4 条）。
- `ReaderPage` 有书时挂 `<ChatDrawer {bookId} />` 和 `useAutoSummary()`（读完一章自动摘要）。
- `ask-xiaoke` 事件：抽屉在 window 上听，打开抽屉、把那个词放 `<recent_words>` 第一位（标"她刚问的"）、输入框预填"「词」在这儿是什么意思？"（"有意思"条目是"这里有什么梗？"），她可以改了再发。

**B. 小克抽屉**
- 文件：`src/chat/context.ts`（上下文组装，纯函数）、`src/chat/session.ts`（一轮：拼请求 → 流式 → 守卫 → 追加历史 → 记账 → 存库；还有取屏幕段落/最近的词/续会话）、`src/chat/summary.ts`（章末触发 + 滚动摘要）、`src/chat/autosummary.svelte.ts`（盯 reading 状态触发）、`src/components/ChatDrawer.svelte`、`src/llm/prompts/summary.ts`。
- 上下文顺序（PLAN 2.9）：system = `CHAT_SYSTEM`（断点 1）→ 会话第一条 user 的第一块 = `<book>` + `<story_so_far>`（断点 2，会话开始时定下，整个会话不变）→ 历史 → 本轮 user = `<reading>`（第几章、防剧透开/关）+ `<screen>`（屏幕段落，≤600 词，问的词所在段一定带）+ `<recent_words>`（≤8 个）+ 问题，最后一块打断点 3。易变的东西只在本轮 user 里，发出去就成了历史、不再改。
- **历史只追加不改写**：助手回复连 thinking 块（含签名）原样存、原样发回。输出守卫（和本章原文 ≥8 词连续重合 → "（原文略）"）只改显示，存在 `ChatRecord.display`；发回 API 的 `messages` 不动。理由：改历史 = 缓存从那里断，而且 Sonnet/Opus 5.5 的 thinking 签名绑定前缀，改了就失效（2026-08-31 以后的新账号直接 400）。原文只会回到 Anthropic，不外流，不违反红线。
- 中英切换：抽屉上"中/EN"。不改 system，下一句发出时紧跟在那条 user 后面追加 `{role:'system', content: CHAT_EN_MODE}`（切回中文是新加的 `CHAT_ZH_MODE`）。API 要求中途 system 消息跟在 user 后面、不能是 messages[0]，所以是"下一句起"生效，抽屉上有提示。
- 防剧透：抽屉上的开关和设置页是同一个（`settings.noSpoilers`），每轮写进 `<reading>`。前情摘要只取当前章之前的。
- 聊天模型：设置页切（T1 已有），每轮现读；换模型那一轮缓存重写（缓存按模型分）。抽屉标题旁显示当前模型名。
- 会话：同一本书、同一章、6 小时内打开抽屉接着上次聊；换章开新会话（前情跟着换）。"新话题"按钮手动开新的。请求体超过 180KB（代理卡 256KB）自动开新话题并提示。
- 出错：被拒（refusal）/网络错/429 都回滚本轮（历史里不留半截），中文提示，问题放回输入框。被拒那次照样记账、记一笔守卫（kind=refusal）。
- 每条回复下面一行小字：模型 · 缓存读 · 新输入 · 输出 · 本轮美元。看缓存命中、看花费都靠它。

**前情摘要**
- 触发点：本章最后一段出现在屏幕上（`chapterFinished` / `summaryToTrigger`，有单测）。"下一章"按钮就在最后一段后面，正常翻章必经；从目录跳过去、没看到最后一段的章不生成（没读的不该进前情）。没口令不触发。失败了下次读到章末再试。
- 生成：Haiku，按 T3 的分组**滚动摘要**，每次发"已有摘要 + 下一组原文（≤900 词左右）+ 前几章摘要（认人名用，≤400 字）"，回来更新后的摘要；≤300 字截断；过守卫；存 summaries。用 structured outputs `{summary}` 是为了复用 T3 的 `callStructured`（Haiku 被拒 → Sonnet 重试一次 + 记账，purpose=summary）。
- 标注那边 `<story_so_far>` 本来就读 summaries 表，所以摘要一有，后面章节的标注也有前情了。

**验收结果**

| 项 | 结果 |
|---|---|
| `npm run lint` / `npm run build` | 通过（0 错 0 警告；103 个单测 + 1 个跳过，T4 新增 21 个） |
| 浏览器 headless（`scripts/t4-browser.mjs`，390px，真构建产物 + 真 SDK，只有 `/api/anthropic/*` 用 CDP 拦下回假数据） | 10/10 过：导入彼得潘 52 段 → 标注层出现（假标注：20 处生词虚线、3 个 ※）→ 点 delightful 出卡片 → 点"问小克"抽屉弹出、上下文带 delightful、输入框预填 → 发送：拦下的请求 `<recent_words>` 第一位是 delightful、system 只有人格、断点在前情块和最后一块、`fallbacks:"default"` → 流式回复显示 → 账本有 purpose=chat 一行 → 关抽屉滚到章末 → 自动发了 4 次摘要请求、summaries 有第 1 章 → 页面 0 报错。截图 `shots/t4-card.png`、`shots/t4-drawer.png`，明细 `shots/t4-data/browser.json` |
| 摘要触发点单测（`test/summary.test.ts`） | 最后一段可见才触发；已有/正在生成/没口令/章号无效不触发；滚动摘要每次 ≤1000 词、带上一版；300 字截断；8 词重合换"（原文略）"并记守卫；同章并发只跑一次 |
| 聊天单测（`test/chat.test.ts`） | 上下文顺序和 3 个断点；第二轮请求 = 第一轮请求 + 助手原样回复（去掉 cache_control 后逐字节相同）；thinking 块和签名原样回传；切英文 system 不变、中途 system 紧跟 user、断点不在 system 消息上、不重复追加、切回中文；"念原文"显示被守卫、历史不改、记守卫；refusal/429 回滚；换 Opus；recent_words 排序；续会话/换章 |
| 假跑 `t4-real.ts --mock`（缓存模拟器：按断点前缀逐字节比对） | 9/9 过：第二轮 cache_read 689→1010→1342 逐轮涨（前缀没被改过）；切英文后 cache_read 仍 >0；念原文被守卫换成"（原文略）"；防剧透开/关两种回答走对了分支（假模型，只验链路） |
| **同一会话第二轮 `cache_read_input_tokens > 0`（真）** | 过：第一轮写缓存 1773，之后 cache_read 1773 → 2558 → 3179 逐轮涨 |
| **防剧透开/关各问一次"胡克最后怎么样"（真）** | 过：开着时说"防剧透开着…想知道就说剧透我"，没漏结局；关着时直说被鳄鱼吃了、讲了 bad form |
| **英文模式回答是简单英文 + 缓存不失效（真）** | 过：短句英文、难词括号带中文（barking (狂吠)）；cache_read 2558 > 0，system 一字没改 |
| **"把这段原文念给我"被守卫拦或改成中文转述（真）** | 过：模型自己拒绝照搬、改成中文转述，显示里没有 ≥8 词原文 |
| **卡片"问小克"→ `<recent_words>` 带词（真）** | 过（浏览器 + 真跑第 1 步都验了） |

**合同改动（只加不改）**
- `types.ts`：`ChatRecord.messages` 放宽成 `(MessageParam | BetaMessageParam)[]`（中途 `role:"system"` 只在 beta 类型里；老数据照样合法，目前没有别的读者）；`ChatRecord` 加可选 `updatedAt / chapter / model / display`；新类型 `ChatLine`。
- `db.ts` 没动（chats、summaries 表 T1 就建好了）。
- `annotate/profile.ts` 的 `storySoFar` 加了可选 `maxChars`（默认还是 600，聊天用 1500）。`llm/prompts/chat.ts` 加了 `CHAT_ZH_MODE`。

**和 PLAN 不一样 / PLAN 没写死的地方**
1. **摘要不是一次发整章**（PLAN 第 6 节按"7K 入"估算），而是按组滚动，守住第 4 节"每次只发 ≤900 词"。花费同一量级（一章 4–8 次 Haiku，约 $0.001）。PLAN 第 6 节已加注。
2. **守卫只改显示不改历史**（见上）。PLAN 第 4 节说"把这段替换成（原文略）"，她看到的确实被换了；发回模型的那份不换，是为了缓存和 thinking 签名。
3. **英文模式"下一句起"生效**：中途 system 消息只能跟在 user 后面，所以切换时不立刻发东西，下一次发问时一起带上。
4. **※ 原来会伸出屏幕 8px**（390px 宽时整页变 398px，手机上能左右晃；headless 里还把点击坐标带偏了）。在 ReaderView 的 article 右边留了 14px，※ 落在边距里。T3 的定位逻辑没改。
5. 聊天的前情上限 1500 字（标注那边 600），聊天更需要背景，Sonnet 读得起。
6. 右下角"小克"按钮在 T3"标注中…"小牌子上面一点（bottom 52px），两个不打架。

**要她看的**：`shots/t4-card.png`、`shots/t4-drawer.png`（假标注、假回复，只看排版和交互）。抽屉高度 78%、气泡样式、按钮位置都是先拍的，好不好她说了算。

**留意（真跑时看一眼）**
- 服务器端 fallback 万一把聊天转到不支持中途 system 消息的模型，切英文那轮可能 400。真跑第 3 步会暴露；真出了就在 fallback 时去掉 system 消息改成 user 里的提示。
- Sonnet 5.5 的 `CHAT_SYSTEM` 估计 ~700 token，过 512 的缓存下限；真跑看第一轮 `cache_creation_input_tokens` 是否 >0 就知道。

### T5（生词导出 + 备份 + 花费面板）—— 2026-11-04 完成，未部署

全在设置页（`src/pages/SettingsPage.svelte`）下半截：花费 / 词库 / 存储三块。

**验收结果**

| 项 | 结果 |
|---|---|
| 导出的生词文件过 `scripts/validate-export.mjs` | 过：单测（app 的导出结果直接喂校验脚本）+ 浏览器里真点"导出生词"下载的文件（20 条，2 条没释义的被跳过并提示） |
| 清空站点数据后导入备份，词库条数一致（headless） | 过：33 → `Storage.clearDataForOrigin`（等于"清除网站数据"）后 0 → 设置页"从备份恢复"选文件 → 33，每个词状态/释义/点击数一致；水平、防剧透、聊天模型、字号也恢复 |
| 花费面板 = 账本求和，误差 < $0.001 | 过：单测 300 笔随机账（两本书 + 没挂书的），合计、每个用途、每个用途×模型都逐项对账，显示的 3 位小数也 < $0.001；浏览器里 $0.529 vs 账本 $0.529057 |
| `navigator.storage.persist()` | 启动时调（App.svelte），设置页显示"已申请持久存储：是/否/浏览器不支持"。headless 下是"否"（没加主屏幕，正常） |
| `npm run lint` / `npm run build` | 通过（0 错 0 警告；116 个单测 + 1 个跳过，T5 新增 8 个） |
| 截图 390px | `shots/t5-settings.png`（整页，含花费面板；数据是自编的种子） |
| 浏览器验收全程 | `node scripts/t5-browser.mjs`（先 `npm run build && npx vite preview --port 4173`），14/14 过，明细 `shots/t5-data/browser.json` |

**文件**
- `src/export/vocab.ts`：生词导出。`src/export/backup.ts`：备份 / 解析 / 合并导入。`src/llm/spend.ts`：花费分组求和 + `formatUsd`。`src/storage.svelte.ts`：`requestPersist()`、`downloadJson()`。
- `scripts/validate-export.mjs`（+ `.d.mts` 类型）：校验脚本，和 app 的导出代码是两份独立实现（故意的，互相对账）。`scripts/t5-browser.mjs`：headless 验收。
- 测试：`test/export.test.ts`。

**导出生词的形状**（PLAN T5，背单词页 `words` 集合）：数组，每条 `{en, zh, lesson, cluster, key, gloss_zh, context_zh, root, mishearing, mnemonic}`，全是字符串。
- 取 words 表 status 是 learning / unknown 的；按第一次遇到的位置排（书 → 章 → 段）。
- `en` = lemma；`zh` = 词库里的释义，没有就找同 lemma 的 vocab 标注（优先第一次遇到的那段）；都没有 → 跳过并在提示里列出来（zh 必填）。
- `gloss_zh` = 那条标注的 note_zh（补充说明，和 zh 一样就留空）。`lesson` = 书名驼峰 + 章，如 `PeterPan-ch03`（去开头冠词、只留 ASCII、最长 24 字符；全中文书名退成 `Book`）。
- `context_zh` 目前只写"第 N 章"——PLAN 例子里是"德思礼家早餐时找信的那一幕"这种场景描述，库里没有现成的，要再调一次模型才有。MVP 不做，第一次真导出时看她要不要。
- 红线：quote 和段落原文一律不进文件。校验脚本会拦"除 en 外任何字段夹着 ≥6 个连续英文词"、en 超 5 词、多字段、en 重复。
- 文件名 `生词-YYYY-MM-DD.json`。写进背单词页要她把文件交给 Claude 会话导入（PLAN T5：PWA 写不了 ArtifactData）。

**备份**：`{format:"reader-backup", version:1, exportedAt, words:[整张表], settings:{…}}`，文件名 `词库备份-YYYY-MM-DD.json`。
- 导入先整份校验（不是 JSON / 是生词导出文件 / 版本不对 / 状态不对都直接拒，库一行不动），再在一个事务里按 lemma 合并：同 lemma 用备份的整行覆盖，本机多出来的保留。设置用备份覆盖。

**和 PLAN 不一样 / PLAN 没写死的地方**
1. **备份不带应用口令。** 备份文件会进下载目录、可能发给 Claude 会话，口令一漏别人就能花她的额度。导入时保留本机口令；清空数据后恢复，口令要重新填。
2. **金额显示 3 位小数（$0.529）**，不是 PLAN 写的 `$x.xx`：两位小数四舍五入最多差 $0.005，过不了"误差 < $0.001"。不到千分之一但不为 0 的写 `<$0.001`。
3. 花费面板放在设置页（不放抽屉顶部）：抽屉每条回复下已经有本轮花费，总账放设置页够了。面板下面顺手加了"前情摘要已生成 N 章"（收口清单里说过线上验摘要时想看）和"所有书合计 + 按模型"一行。
4. 书、标注、聊天、账本不进备份（书有版权，其余能重新生成或不值得搬）。

## 本地测页面的小技巧

- Chrome headless 的 `--dump-dom` 一次性模式里 IndexedDB 会卡住，页面会停在只有标题的状态（不是代码问题）。要看真实渲染，用 `--remote-debugging-port` 开正常会话再用 CDP 取 `document.body.innerText`。
- 换了构建后浏览器还在用旧版，是 service worker 的 prompt 模式在等确认：点横条，或用干净的浏览器配置。

## 已知小事

- `npm audit` 报 11 个 low/moderate，全在构建工具链（workbox-build、glob、ejs 等），运行时依赖 0 个。等 vite-plugin-pwa 升级再说。
- 图标是脚本画的占位（米色底 + 一本摊开的书），好不好看她说了算，替换 `public/icon-192.png` / `icon-512.png` 即可。
- TypeScript 用 6.0.3 不是最新的 7.0：svelte-check 只支持到 TS 6。

## 收口清单（还差什么才能部署给她用）

2026-11-04 改直连 + GitHub Pages 后重排。打勾的是剧组已做完的：

- [x] T1–T5 代码、单测、headless 验收（假 API）
- [x] 本机真跑（`bash scripts/real-all.sh`）：T3 锚定 98.8%、T4 9/9 过，实测花费已填进 PLAN 第 6 节
- [x] 改直连模式（设置页填 key、浏览器直连、白名单挪到客户端、CSP meta、base `/reader/`、Pages 工作流），真请求验收 11/11（见"直连模式"一节）
- [ ] **建公开仓 `reader` + push**（她已同意公开）→ Settings → Pages → Source 选 "GitHub Actions" → 等 Actions 部署完，`https://<用户>.github.io/reader/` 返回 200
- [ ] **她**：手机打开网址 → 加到主屏幕 → 设置页填 Anthropic API key → 点"测一下"显示"通了"
- [ ] **她**：导入一本书（彼得潘或 HP）→ 看标注出来、点词、问小克、读完一章看前情（设置页花费面板下有"前情摘要已生成 N 章"）；设置页看"已申请持久存储"加到主屏幕后是不是"是"
- [ ] **她**：Anthropic 控制台给这个 key 所在 workspace 设月度花费上限（key 存在手机里，丢了也有上限）
- [ ] 手机上断网再开一次（桌面 headless 已验）
- [ ] **她**：看 `shots/t3-ch{1,5,12}.png` 和 `-sonnet.png` 拍板标注 prompt / 要不要换 Sonnet（Haiku 全书约 $0.25，Sonnet 约 $2.9）；看 `shots/t4-data/report.json` 里小克的原话
- [ ] 第一次导出生词交给 Claude 导进背单词页：定 HP 的词放哪个 collection / 哪一页（PLAN T5），看 context_zh 只有"第 N 章"够不够
- [ ] AO3 EPUB 验一次（T2 遗留，AO3 维护结束后）
