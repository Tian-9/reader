// 首用反馈修复（2026-11-04）的浏览器验收：headless Chrome、390px 手机宽、真实构建产物 + 真 SDK，只把 https://api.anthropic.com/* 换成假回复（不花钱）。
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/fix1-browser.mjs [http://localhost:4173/reader/] [--epub books/peter-pan.epub] [--out shots]
//
// 验：
//  1. 假标注里故意放一个被标成 B2 的常用词、一个句中大写的人名 → 都不划虚线；正常的 C1 词照划
//  2. 第一组晚回 1.5s：右下角"标注中…"；第一组回了、第二组（屏幕外）还没回：只剩"预取下一段"小字，没有"标注中…"
//  3. 滚到章末："下一章"和"小克"按钮不重叠（量矩形），截 fix1-reading.png
//  4. 目录 → 本章生词：列表按出现顺序、不含被闸住的词，截 fix1-wordlist.png；点一条 → 面板关、那段滚进屏幕
//  5. 页面 0 报错
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BASE = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'http://localhost:4173/reader/';
const EPUB = path.resolve(opt('--epub', 'books/peter-pan.epub'));
const OUT = path.resolve(opt('--out', 'shots'));
mkdirSync(path.join(OUT, 'fix1-data'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, steps: [], requests: [], errors: [], planted: {} };
const step = (name, pass, detail) => {
  report.steps.push({ name, pass, detail });
  console.log(`${pass ? '过' : '不过'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''}`);
};

// ───────── 假标注 ─────────
let annotateN = 0;
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
  // 故意放进去的坏条目：常用词标成 B2（像首用时的 country）、句中大写的人名（像 Potter）
  const common = lines.find(([, , t]) => /\b(children|house|country|mother)\b/.test(t));
  if (common) {
    const w = /\b(children|house|country|mother)\b/.exec(common[2])[1];
    items.push({ ...base, kind: 'vocab', p: common[1], quote: w, lemma: w, level: 'B2', gloss_zh: '（假）常用词' });
    report.planted.common ??= w;
  }
  for (const [, pid, t] of lines) {
    const m = /[a-z,;] ([A-Z][a-z]{3,})\b/.exec(t);
    if (m && !['This', 'That', 'They', 'There', 'Then', 'What', 'When'].includes(m[1])) {
      items.push({ ...base, kind: 'vocab', p: pid, quote: m[1], lemma: m[1], level: 'C1', gloss_zh: '（假）人名' });
      report.planted.name ??= m[1];
      break;
    }
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

// ───────── CDP ─────────
const profile = mkdtempSync(path.join(os.tmpdir(), 'fix1-chrome-'));
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


const pillText = `[...document.querySelectorAll('.pill')].map((e) => e.textContent.trim()).join('|')`;
const rect = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; })()`;
const overlap = (a, b) => !!a && !!b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

try {
  await connect();
  handlers.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') report.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  handlers.push(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const cors = [{ name: 'access-control-allow-origin', value: '*' }];
    if (request.method === 'OPTIONS') {
      await send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [...cors, { name: 'access-control-allow-headers', value: '*' }, { name: 'access-control-allow-methods', value: 'POST' }] });
      return;
    }
    let body = {};
    try {
      body = JSON.parse(request.postData ?? '{}');
    } catch {}
    const schemaKeys = Object.keys(body.output_config?.format?.schema?.properties ?? {});
    const kind = schemaKeys.includes('items') ? 'annotate' : schemaKeys.includes('summary') ? 'summary' : 'other';
    let text;
    if (kind === 'annotate') {
      const n = ++annotateN;
      // 第 1 组（k）晚 1.5s 回、第 2 组（k+1）晚 4s 回，其余马上回
      await sleep(n === 1 ? 1500 : n === 2 ? 4000 : 50);
      text = JSON.stringify(jsonMessage(body.model, annotateReply(body)));
    } else if (kind === 'summary') text = JSON.stringify(jsonMessage(body.model, { summary: '（假摘要）达林家的孩子们出场。' }));
    else text = JSON.stringify(jsonMessage(body.model, { lemma: 'x', level: 'B2', gloss_zh: '（假）补注', note_zh: '' }));
    report.requests.push({ kind, t: Date.now() });
    await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...cors], body: Buffer.from(text).toString('base64') });
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setBypassServiceWorker', { bypass: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.anthropic.com/*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  await send('Page.navigate', { url: BASE });
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读'`);
  await sleep(300);
  await evaluate(`new Promise((res, rej) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key: 'app', apiKey: 'mock-key-not-real', level: 'B1', noSpoilers: true, models: {} }); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); })`);
  await send('Page.reload');
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读' && !!document.querySelector('input[type=file]')`);

  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [EPUB] });
  const paras = await waitFor(`document.querySelectorAll('article .para[data-pid]').length`, 20000, '段落');
  step('导入彼得潘 → 阅读页出段落', paras > 10, { paras });

  // 2. 小牌子：k 还没回 → 标注中…
  const p1 = await waitFor(`${pillText} || null`, 5000, '小牌子');
  step('当前屏幕的段落还没标好 → "标注中…"', p1 === '标注中…', { pill: p1 });
  // k 回了、k+1 还在路上 → 只剩"预取下一段"
  await waitFor(`(CSS.highlights.get('rd-vocab')?.size ?? 0) > 0`, 8000, '第一组虚线');
  await sleep(200);
  const p2 = await evaluate(pillText);
  const vis = await evaluate(`(() => { const ids = [...document.querySelectorAll('article .para[data-pid]')].filter((e) => { const b = e.getBoundingClientRect(); return b.bottom > 96 && b.top < innerHeight; }).map((e) => e.dataset.pid); return ids; })()`);
  step('当前屏幕都标好、只在等下一组 → 不显示"标注中…"，只有"预取下一段"小字', p2 === '预取下一段', { pill: p2, visibleParas: vis.length, annotateRequests: annotateN });
  await waitFor(`${pillText} === ''`, 10000, '小牌子消失');
  step('两组都回来 → 小牌子消失', true);

  // 1. 两道闸
  const hl = await evaluate(`[...CSS.highlights.get('rd-vocab')].map((r) => r.toString())`);
  const planted = report.planted;
  step('被标成 B2 的常用词不划虚线', !!planted.common && !hl.some((w) => w.toLowerCase() === planted.common), { planted: planted.common, highlighted: hl });
  step('句中大写的人名不划虚线', !!planted.name && !hl.includes(planted.name), { planted: planted.name });
  step('正常的 C1 生词照划', hl.length >= 3, { count: hl.length });

  // 3. 章末两个按钮不重叠
  await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight); true`);
  await sleep(800);
  await waitFor(`${pillText} === ''`, 10000, '章末小牌子消失');
  await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight); true`);
  await sleep(500);
  const next = await evaluate(rect('.chapnav button.primary'));
  const fab = await evaluate(rect('.fab'));
  const pillR = await evaluate(rect('.pill'));
  await shot(path.join(OUT, 'fix1-reading.png'));
  step('滚到章末："下一章"和"小克"不重叠（截图 fix1-reading.png）', !!next && !!fab && !overlap(next, fab) && !overlap(next, pillR), { next, fab, gap: next && fab ? Math.round(fab.y - next.b) : null });

  // 4. 本章生词
  await clickSel('.toolbar .tb');
  await clickSel('[data-testid=tab-chapter-words]');
  const list = await waitFor(`(() => { const l = [...document.querySelectorAll('[data-testid=chapter-words] li .lemma')].map((e) => e.textContent); return l.length ? l : null; })()`, 5000, '本章生词');
  await sleep(300);
  await shot(path.join(OUT, 'fix1-wordlist.png'));
  const order = await evaluate(`[...document.querySelectorAll('[data-testid=chapter-words] li')].length`);
  step('目录 → 本章生词：有列表、不含被闸住的词（截图 fix1-wordlist.png）', list.length >= 3 && !list.some((w) => w.toLowerCase() === planted.common || w === planted.name), { n: order, first: list.slice(0, 6) });
  // 点最后一条 → 面板关、那段进屏幕
  await evaluate(`window.scrollTo(0, 0); true`);
  await clickSel('[data-testid=chapter-words] li:last-child button');
  await sleep(600);
  const jumped = await evaluate(`(() => { const sheetOpen = !!document.querySelector('.sheet'); const last = [...CSS.highlights.get('rd-active') ?? []][0]; const b = last?.getClientRects()[0]; return { sheetOpen, flashed: last?.toString() ?? null, onScreen: !!b && b.top > 0 && b.bottom < innerHeight }; })()`);
  step('点一条生词 → 面板关、滚到那段、那个词闪一下', !jumped.sheetOpen && jumped.onScreen, { ...jumped, clicked: list.at(-1) });

  step('页面 0 报错', report.errors.length === 0, report.errors.slice(0, 5));
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  console.error(e);
  try {
    await shot(path.join(OUT, 'fix1-data', 'fail.png'));
  } catch {}
} finally {
  report.allPass = !report.fatal && report.steps.every((s) => s.pass);
  writeFileSync(path.join(OUT, 'fix1-data', 'browser.json'), JSON.stringify(report, null, 2));
  console.log(report.allPass ? '\n全部通过' : '\n有没过的', '→', path.join(OUT, 'fix1-data', 'browser.json'));
  ws?.close();
  proc.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  process.exit(report.allPass ? 0 : 1);
}
