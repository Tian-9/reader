// T4 浏览器验收（headless Chrome，CDP 驱动，390px 手机宽）：真实的构建产物 + 真 SDK，只把 /api/anthropic/* 用假回复顶掉。
//
//   npm run build && npx vite preview --port 4173 &      # 先起静态预览
//   node scripts/t4-browser.mjs [http://localhost:4173] [--epub books/peter-pan.epub] [--out shots]
//
// 走一遍：填口令 → 导入彼得潘 → 阅读页出现标注层（假标注）→ 点一个虚线词出卡片（截 t4-card.png）
// → 卡片上点"问小克" → 抽屉弹出，上下文里带着这个词 → 发送，拦下的请求里 <recent_words> 第一位是它，流式回复显示出来（截 t4-drawer.png）
// → 关抽屉、滚到章末 → 自动发起本章摘要请求、summaries 表里有了第 1 章。
// 假回复：CDP 的 Fetch 域在网络层拦请求（Network.setBypassServiceWorker 绕开 service worker），标注/摘要/点词回 JSON，聊天回 SSE 流。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BASE = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'http://localhost:4173';
const EPUB = path.resolve(opt('--epub', 'books/peter-pan.epub'));
const OUT = path.resolve(opt('--out', 'shots'));
mkdirSync(path.join(OUT, 't4-data'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, steps: [], requests: [], errors: [] };
const step = (name, pass, detail) => {
  report.steps.push({ name, pass, detail });
  console.log(`${pass ? '过' : '不过'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : ''}`);
};

// ───────── 假回复 ─────────
function annotateReply(body) {
  const user = typeof body.messages[0].content === 'string' ? body.messages[0].content : body.messages[0].content.map((b) => b.text).join('');
  const lines = [...user.matchAll(/^\[(c\d+p\d+)\] (.*)$/gm)];
  const items = [];
  const base = { occ: 1, invented: false, fun_type: '-', gloss_zh: '', note_zh: '' };
  for (const [, pid, text] of lines) {
    const long = (text.match(/\b[a-z]{9,}\b/g) ?? [])[0];
    if (long) items.push({ ...base, kind: 'vocab', p: pid, quote: long, lemma: long, level: 'C1', gloss_zh: `（假释义）${long}` });
    if (items.length >= 8) break;
  }
  const [, p0, t0] = lines[0];
  items.push({ ...base, kind: 'fun', p: p0, quote: t0.split(/\s+/).slice(0, 2).join(' '), lemma: '', level: '-', fun_type: '作者幽默', note_zh: '（假）作者在这儿逗你。' });
  return { items };
}
function jsonMessage(model, obj) {
  return {
    id: 'msg_mock', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: JSON.stringify(obj), citations: null }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}
function sse(model, text) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const parts = [text.slice(0, 12), text.slice(12)];
  return (
    ev('message_start', { message: { id: 'msg_mock_chat', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 1800 } } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'mock-sig' } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('content_block_start', { index: 1, content_block: { type: 'text', text: '', citations: null } }) +
    parts.map((t) => ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: t } })).join('') +
    ev('content_block_stop', { index: 1 }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 40, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 1800 } }) +
    ev('message_stop', {})
  );
}

// ───────── CDP ─────────
const profile = mkdtempSync(path.join(os.tmpdir(), 't4-chrome-'));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let ws;
let id = 0;
const pending = new Map();
const handlers = [];
async function connect() {
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(100);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('Chrome 没起来');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) for (const h of handlers) h(msg);
  };
}
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面脚本出错：' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
};
async function waitFor(expr, ms = 15000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await evaluate(expr);
      if (v) return v;
    } catch {}
    await sleep(150);
  }
  throw new Error(`等不到：${label}`);
}
async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
async function clickSel(sel) {
  const r = await waitFor(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:'center'}); const b = e.getBoundingClientRect(); return {x: b.x + b.width/2, y: b.y + b.height/2}; })()`, 10000, sel);
  await sleep(100);
  await click(r.x, r.y);
}
async function shot(file) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(s.data, 'base64'));
}

try {
  await connect();
  handlers.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') report.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  // 拦 API
  handlers.push(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    let body = {};
    try {
      body = JSON.parse(request.postData ?? '{}');
    } catch {}
    const schemaKeys = Object.keys(body.output_config?.format?.schema?.properties ?? {});
    const kind = body.stream ? 'chat' : schemaKeys.includes('items') ? 'annotate' : schemaKeys.includes('summary') ? 'summary' : 'tap';
    report.requests.push({ kind, model: body.model, body: kind === 'chat' ? body : undefined });
    let status = 200;
    let headers = [{ name: 'content-type', value: 'application/json' }];
    let text;
    if (kind === 'chat') {
      headers = [{ name: 'content-type', value: 'text/event-stream' }];
      const last = [...body.messages].reverse().find((x) => x.role === 'user');
      const ctx = last.content.at(-2).text;
      const w = /<recent_words>\n([^：\n]+)/.exec(ctx)?.[1] ?? '?';
      text = `（假回复）「${w}」这个词在这儿就是字面意思，作者没绕弯子。顺手说一句：口语里也常这么说。(・ω・)`;
      text = sse(body.model, text);
    } else if (kind === 'annotate') text = JSON.stringify(jsonMessage(body.model, annotateReply(body)));
    else if (kind === 'summary') text = JSON.stringify(jsonMessage(body.model, { summary: '（假摘要）达林家的三个孩子和保姆狗娜娜出场。' }));
    else text = JSON.stringify(jsonMessage(body.model, { lemma: 'x', level: 'B2', gloss_zh: '（假）补注', note_zh: '' }));
    await send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: headers, body: Buffer.from(text).toString('base64') });
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setBypassServiceWorker', { bypass: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/anthropic/*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // 1. 打开、填口令（直接写 IndexedDB 的 settings 行，再刷新）
  await send('Page.navigate', { url: BASE });
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读'`);
  await sleep(300);
  await evaluate(`new Promise((res, rej) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key: 'app', appToken: 'mock-token', level: 'B1', noSpoilers: true, models: {} }); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); })`);
  await send('Page.reload');
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读' && !!document.querySelector('input[type=file]')`);

  // 2. 导入彼得潘
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [EPUB] });
  const paras = await waitFor(`document.querySelectorAll('article .para[data-pid]').length`, 20000, '段落');
  step('导入彼得潘 → 阅读页出段落', paras > 10, { paras });

  // 3. 标注层：假标注画出来
  const vocab = await waitFor(`(CSS.highlights.get('rd-vocab')?.size ?? 0) || 0`, 15000, '生词虚线');
  const marks = await evaluate(`document.querySelectorAll('.rd-marks .mark').length`);
  step('阅读页出现标注层（生词虚线 + ※）', vocab > 0, { vocabRanges: vocab, funMarks: marks, annotateRequests: report.requests.filter((r) => r.kind === 'annotate').length });

  // 4. 点第一个虚线词 → 卡片
  const hit = await evaluate(`(() => {
    const r = [...CSS.highlights.get('rd-vocab')][0];
    r.startContainer.parentElement.scrollIntoView({ block: 'center' });
    return true; })()`);
  await sleep(500);
  const pos = await evaluate(`(() => { const r = [...CSS.highlights.get('rd-vocab')][0]; const b = r.getClientRects()[0]; return { x: b.x + b.width / 2, y: b.y + b.height / 2, word: r.toString() }; })()`);
  await evaluate(`window.__taps = []; window.__clicks = []; window.addEventListener('word-tap', (e) => window.__taps.push(e.detail)); for (const t of ['mousedown', 'mouseup', 'click']) document.addEventListener(t, (e) => window.__clicks.push(t + ':' + (e.target.className || e.target.tagName) + '@' + e.clientX + ',' + e.clientY + ' sel=' + JSON.stringify(String(getSelection()))), true); true`);
  await click(pos.x, pos.y);
  await sleep(400);
  report.tapDebug2 = await evaluate(`(() => { const x = Math.trunc(${pos.x}), y = Math.trunc(${pos.y}); const c = document.caretPositionFromPoint?.(x, y); const e = document.elementFromPoint(x, y); return { x, y, posx: ${pos.x}, posy: ${pos.y}, el: e?.className, caret: c && [c.offsetNode.nodeName, c.offset], dpr: devicePixelRatio, vv: visualViewport.scale, iw: innerWidth }; })()`);
  report.tapDebug = await evaluate(`({ taps: window.__taps, clicks: window.__clicks, at: document.elementFromPoint(${pos.x}, ${pos.y})?.outerHTML?.slice(0, 120) })`);
  const cardTitle = await waitFor(`document.querySelector('.card[aria-label="小注"] .title')?.textContent`, 8000, '卡片');
  await sleep(300);
  await shot(path.join(OUT, 't4-card.png'));
  step('点词出卡片（截图 t4-card.png）', !!hit && cardTitle.toLowerCase() === pos.word.toLowerCase(), { word: pos.word, cardTitle });

  // 5. 问小克 → 抽屉 + 上下文含该词
  await clickSel('.card .actions button:last-child');
  await waitFor(`!!document.querySelector('[data-testid=chat-drawer]')`, 5000, '抽屉');
  const ctx = await waitFor(`(() => { const a = document.querySelector('[data-testid=chat-context] .word.asked'); return a && { asked: a.textContent, input: document.querySelector('.drawer textarea').value }; })()`, 5000, '上下文');
  step('点"问小克"抽屉弹出，上下文带着这个词', ctx.asked === cardTitle, ctx);

  // 6. 发送 → 拦下的请求里有 <recent_words>，流式回复显示
  await clickSel('.drawer form button[type=submit]');
  const reply = await waitFor(`document.querySelector('.drawer .msg.assistant')?.textContent?.includes('口语里') && document.querySelector('.drawer .msg.assistant').textContent`, 10000, '回复');
  await sleep(300);
  await shot(path.join(OUT, 't4-drawer.png'));
  const chat = report.requests.find((r) => r.kind === 'chat')?.body;
  const lastUser = chat && [...chat.messages].reverse().find((x) => x.role === 'user');
  const ctxText = lastUser?.content.at(-2)?.text ?? '';
  const recentFirst = /<recent_words>\n([^\n]+)/.exec(ctxText)?.[1] ?? '';
  step('聊天请求：<recent_words> 第一位是这个词', recentFirst.startsWith(cardTitle), { recentFirst });
  step('聊天请求：system 只有人格、前情块和最后一块打断点、防剧透开', !!chat && chat.system.length === 1 && !!chat.system[0].cache_control && !!chat.messages[0].content[0].cache_control && !!lastUser.content.at(-1).cache_control && ctxText.includes('防剧透：开'), { model: chat?.model, fallbacks: chat?.fallbacks, betasInBody: chat?.betas });
  step('流式回复显示在抽屉里（截图 t4-drawer.png）', !!reply, { reply });
  const ledger = await evaluate(`new Promise((res) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const q = r.result.transaction('ledger').objectStore('ledger').getAll(); q.onsuccess = () => res(q.result.filter((x) => x.purpose === 'chat').map((x) => ({ model: x.model, cacheWrite: x.cacheWrite, usd: x.usd }))); }; })`);
  step('聊天记账（purpose=chat）', ledger.length === 1, ledger);

  // 7. 关抽屉、滚到章末 → 自动摘要
  await clickSel('.drawer .x');
  await evaluate(`document.querySelector('article .para[data-pid]:last-of-type')?.scrollIntoView({ block: 'end' }); window.scrollTo(0, document.documentElement.scrollHeight); true`);
  const sum = await waitFor(`new Promise((res) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const q = r.result.transaction('summaries').objectStore('summaries').getAll(); q.onsuccess = () => res(q.result.length ? q.result : null); }; })`, 15000, '摘要入库');
  step('滚到章末 → 自动生成本章摘要（入库）', sum.length === 1 && sum[0].chapter === 1, { chapter: sum[0].chapter, text: sum[0].textZh, summaryRequests: report.requests.filter((r) => r.kind === 'summary').length });

  step('页面 0 报错', report.errors.length === 0, report.errors.slice(0, 5));
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  console.error(e);
  try {
    await shot(path.join(OUT, 't4-data', 'fail.png'));
  } catch {}
} finally {
  for (const r of report.requests) if (r.body) r.body = { model: r.body.model, messages: r.body.messages.length };
  report.allPass = !report.fatal && report.steps.every((s) => s.pass);
  writeFileSync(path.join(OUT, 't4-data', 'browser.json'), JSON.stringify(report, null, 2));
  console.log(report.allPass ? '\n全部通过' : '\n有没过的', '→', path.join(OUT, 't4-data', 'browser.json'));
  ws?.close();
  proc.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  process.exit(report.allPass ? 0 : 1);
}
