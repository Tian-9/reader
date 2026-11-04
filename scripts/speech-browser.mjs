// 朗读功能的 headless 验收（Chrome + CDP，390px 手机宽）：真构建产物，api.anthropic.com 用假回复（同 t4-browser），
// window.speechSynthesis / SpeechSynthesisUtterance 在页面脚本之前换成假的（记下每次 speak/cancel，按文字长度定时触发 onend）。
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/speech-browser.mjs [http://localhost:4173/reader/] [--epub books/peter-pan.epub] [--out shots]
//
// 走一遍：导入彼得潘 → 点一个虚线词出卡片 → 卡片 🔊 调了 speak(词)（截 speech-card.png）
// → 段落 ▶ 从那段开始朗读：朗读条出现、那段高亮、视图滚到它（截 speech-reading.png）
// → 朗读中点词卡片照常开、🔊 读完自动接着读 → 高亮跟到下一段且在屏幕内 → 倍速 1.2x → 暂停/继续 → 停止
// → 最后一段读完自动停 → 设置页声音下拉 + 默认倍速（截 speech-settings.png）→ 去设置页时朗读停。
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
mkdirSync(path.join(OUT, 'speech-data'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, steps: [], errors: [] };
const step = (name, pass, detail) => {
  report.steps.push({ name, pass, detail });
  console.log(`${pass ? '过' : '不过'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : ''}`);
};

// ───────── 假 speechSynthesis（页面脚本之前注入） ─────────
const FAKE_TTS = `
(() => {
  const voicesAll = [
    { name: 'Google 普通话（中国大陆）', lang: 'zh-CN', voiceURI: 'Google 普通话（中国大陆）', default: true, localService: false },
    { name: 'Google US English', lang: 'en-US', voiceURI: 'Google US English', default: false, localService: false },
    { name: 'English United Kingdom', lang: 'en_GB', voiceURI: 'en-gb-x-gba-local', default: false, localService: true },
    { name: 'Google UK English Female', lang: 'en-GB', voiceURI: 'Google UK English Female', default: false, localService: false },
    { name: 'Google UK English Male', lang: 'en-GB', voiceURI: 'Google UK English Male', default: false, localService: false },
  ];
  let voices = []; // 一开始空：模拟安卓上 getVoices() 先返回空、之后才来 voiceschanged
  const listeners = [];
  const tts = { log: [], queue: [], timer: null };
  window.__tts = tts;
  class SpeechSynthesisUtterance {
    constructor(text) { this.text = text ?? ''; this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null; this.onstart = this.onend = this.onerror = this.onpause = this.onresume = this.onboundary = null; }
    addEventListener() {}
  }
  function pump() {
    if (tts.timer || !tts.queue.length) return;
    const u = tts.queue[0];
    u.onstart?.({});
    tts.timer = setTimeout(() => {
      tts.timer = null;
      tts.queue.shift();
      tts.log.push({ kind: 'end', text: u.text });
      u.onend?.({});
      pump();
    }, Math.min(1200, 100 + u.text.length * 3));
  }
  const synth = {
    get speaking() { return tts.queue.length > 0; },
    get pending() { return tts.queue.length > 1; },
    paused: false,
    getVoices: () => voices.slice(),
    speak(u) { tts.log.push({ kind: 'speak', text: u.text, rate: u.rate, lang: u.lang, voice: u.voice?.name ?? null }); tts.queue.push(u); pump(); },
    cancel() { tts.log.push({ kind: 'cancel' }); clearTimeout(tts.timer); tts.timer = null; const q = tts.queue.splice(0); for (const u of q) u.onerror?.({ error: 'interrupted' }); },
    pause() {}, resume() {},
    addEventListener(t, fn) { if (t === 'voiceschanged') listeners.push(fn); },
    removeEventListener() {},
    onvoiceschanged: null,
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  window.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
  setTimeout(() => { voices = voicesAll; for (const l of listeners) l(); synth.onvoiceschanged?.(); }, 120);
})();
`;

// ───────── 假 API 回复（同 t4-browser） ─────────
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

// ───────── CDP ─────────
const profile = mkdtempSync(path.join(os.tmpdir(), 'speech-chrome-'));
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
    await sleep(120);
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
const log = () => evaluate('JSON.parse(JSON.stringify(window.__tts.log))');
const lastSpeak = (l) => [...l].reverse().find((x) => x.kind === 'speak');
const TOP = 52 + 44 + 40; // 顶栏 + 工具条 + 朗读条

try {
  await connect();
  handlers.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') report.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  handlers.push(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    let body = {};
    try {
      body = JSON.parse(request.postData ?? '{}');
    } catch {}
    const cors = [{ name: 'access-control-allow-origin', value: '*' }];
    if (request.method === 'OPTIONS') {
      await send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [...cors, { name: 'access-control-allow-headers', value: '*' }, { name: 'access-control-allow-methods', value: 'POST' }] });
      return;
    }
    const schemaKeys = Object.keys(body.output_config?.format?.schema?.properties ?? {});
    const kind = body.stream ? 'chat' : schemaKeys.includes('items') ? 'annotate' : schemaKeys.includes('summary') ? 'summary' : 'tap';
    let text;
    if (kind === 'annotate') text = JSON.stringify(jsonMessage(body.model, annotateReply(body)));
    else if (kind === 'summary') text = JSON.stringify(jsonMessage(body.model, { summary: '（假摘要）达林家的三个孩子和保姆狗娜娜出场。' }));
    else if (kind === 'tap') text = JSON.stringify(jsonMessage(body.model, { lemma: 'x', level: 'B2', gloss_zh: '（假）补注', note_zh: '' }));
    else text = JSON.stringify(jsonMessage(body.model, {}));
    await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...cors], body: Buffer.from(text).toString('base64') });
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setBypassServiceWorker', { bypass: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.anthropic.com/*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_TTS });

  // 1. 打开、填 key、导入
  await send('Page.navigate', { url: BASE });
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读'`);
  await sleep(300);
  await evaluate(`new Promise((res, rej) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key: 'app', apiKey: 'mock-key-not-real', level: 'B1', noSpoilers: false, models: {} }); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); })`);
  await send('Page.reload');
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读' && !!document.querySelector('input[type=file]')`);
  const fake = await evaluate(`!!window.__tts && typeof SpeechSynthesisUtterance === 'function'`);
  step('假 speechSynthesis 注入成功', fake);
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [EPUB] });
  const paras = await waitFor(`document.querySelectorAll('article .para[data-pid]').length`, 20000, '段落');
  const says = await evaluate(`document.querySelectorAll('article .para[data-pid] > button.say[data-nontext]').length`);
  const sayText = await evaluate(`[...document.querySelectorAll('article .para .say')].every((b) => b.textContent === '')`);
  step('导入彼得潘 → 每段左边有 ▶（空按钮，不带文字节点）', paras > 10 && says === paras && sayText, { paras, says });

  // 2. 标注层出来，找第一个虚线词和它所在的段
  await waitFor(`(CSS.highlights.get('rd-vocab')?.size ?? 0) > 0`, 15000, '生词虚线');
  const target = await evaluate(`(() => {
    const r = [...CSS.highlights.get('rd-vocab')][0];
    const pid = r.startContainer.parentElement.closest('[data-pid]').dataset.pid;
    return { pid, word: r.toString() }; })()`);
  const wordPos = async () => {
    await evaluate(`(() => { const r = [...CSS.highlights.get('rd-vocab')][0]; r.startContainer.parentElement.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(400);
    return evaluate(`(() => { const r = [...CSS.highlights.get('rd-vocab')][0]; const b = r.getClientRects()[0]; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  };

  // 3. 点词 → 卡片 → 🔊
  let pos = await wordPos();
  await click(pos.x, pos.y);
  const cardTitle = await waitFor(`document.querySelector('.card[aria-label="小注"] .title')?.textContent`, 8000, '卡片');
  const hasSay = await evaluate(`!!document.querySelector('.card [data-testid=say-word]')`);
  step('点词出卡片，卡片上有 🔊', cardTitle.toLowerCase() === target.word.toLowerCase() && hasSay, { word: target.word, cardTitle });
  await clickSel('.card [data-testid=say-word]');
  await sleep(150);
  let l = await log();
  const sp = lastSpeak(l);
  const idx = l.indexOf(sp);
  step('🔊 → 先 cancel 再 speak(点中的词)，用 Google UK English Female、en-GB', !!sp && sp.text.toLowerCase() === target.word.toLowerCase() && l[idx - 1]?.kind === 'cancel' && sp.voice === 'Google UK English Female' && sp.lang === 'en-GB', sp);
  await shot(path.join(OUT, 'speech-card.png'));
  await clickSel('.card .x');
  await waitFor(`!document.querySelector('.card[aria-label="小注"]')`, 3000, '卡片关闭');

  // 4. 段落 ▶ → 从那段开始朗读
  await clickSel(`.para[data-pid="${target.pid}"] .say`);
  const bar = await waitFor(`(() => { const b = document.querySelector('[data-testid=speech-bar]'); return b && b.textContent.replace(/\\s+/g, ' ').trim(); })()`, 5000, '朗读条');
  const speakingPid = await evaluate(`document.querySelector('.para.speaking')?.dataset.pid`);
  l = await log();
  const first = lastSpeak(l);
  const paraText = await evaluate(`document.querySelector('.para[data-pid="${target.pid}"]').textContent`);
  step('朗读条出现"朗读中 · 1.0x"，那段高亮，第一条 utterance 是那段开头、≤200 字符、倍速 1.0', bar.includes('朗读中') && bar.includes('1.0x') && speakingPid === target.pid && !!first && paraText.replace(/\s+/g, ' ').trim().startsWith(first.text) && first.text.length <= 200 && first.rate === 1, { bar, speakingPid, first });
  await sleep(700);
  const rect1 = await evaluate(`(() => { const r = document.querySelector('.para.speaking').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()`);
  step('视图滚到正在读的段（段首在朗读条下面、屏幕内）', rect1.top >= TOP - 8 && rect1.top < 844, rect1);
  await shot(path.join(OUT, 'speech-reading.png'));

  // 5. 朗读中点词：卡片照开、🔊 读完自动接着读
  pos = await evaluate(`(() => { const r = [...CSS.highlights.get('rd-vocab')][0]; const b = r.getClientRects()[0]; return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; })()`);
  if (!pos || pos.y < TOP) {
    // 词被滚出屏幕或压在条下面：这一段开始读时段首对着条，词一般就在下面几行；不在就把它滚进来
    pos = await wordPos();
  }
  await click(pos.x, pos.y);
  const cardTitle2 = await waitFor(`document.querySelector('.card[aria-label="小注"] .title')?.textContent`, 8000, '朗读中的卡片');
  const barStill = await evaluate(`!!document.querySelector('[data-testid=speech-bar]')`);
  step('朗读中点词：卡片照常打开，朗读条还在', cardTitle2.toLowerCase() === target.word.toLowerCase() && barStill, { cardTitle2 });
  const before = (await log()).length;
  await clickSel('.card [data-testid=say-word]');
  const paused = await waitFor(`document.querySelector('[data-testid=speech-bar]')?.textContent.includes('已暂停')`, 3000, '暂停');
  const resumed = await waitFor(`document.querySelector('[data-testid=speech-bar]')?.textContent.includes('朗读中')`, 5000, '自动继续');
  l = await log();
  const tail = l.slice(before).filter((x) => x.kind === 'speak').map((x) => x.text);
  step('朗读中按 🔊：先暂停读单词，单词念完自动接着读', paused && resumed && tail[0]?.toLowerCase() === target.word.toLowerCase() && tail.length >= 2, { tail });
  await clickSel('.card .x');
  await waitFor(`!document.querySelector('.card[aria-label="小注"]')`, 3000, '卡片关闭');

  // 6. 高亮跟到下一段，视图跟着滚
  const nextPid = await waitFor(`(() => { const p = document.querySelector('.para.speaking')?.dataset.pid; return p && p !== ${JSON.stringify(target.pid)} ? p : null; })()`, 20000, '读到下一段');
  await sleep(900);
  const rect2 = await evaluate(`(() => { const r = document.querySelector('.para.speaking').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()`);
  step('读完一段高亮跳到下一段，视图跟着滚', nextPid > target.pid && rect2.top >= TOP - 8 && rect2.top < 844, { nextPid, rect2 });

  // 7. 倍速
  await clickSel('[data-testid=speech-rate]');
  const rateText = await waitFor(`document.querySelector('[data-testid=speech-rate]')?.textContent`, 2000, '倍速');
  await sleep(100);
  l = await log();
  step('倍速点一下 → 1.2x，当前句按 1.2 重念', rateText === '1.2x' && lastSpeak(l)?.rate === 1.2, { rateText, rate: lastSpeak(l)?.rate });

  // 8. 暂停 / 继续
  await clickSel('[data-testid=speech-toggle]');
  const p1 = await waitFor(`document.querySelector('[data-testid=speech-bar]')?.textContent.includes('已暂停') && document.querySelector('[data-testid=speech-toggle]')?.textContent`, 2000, '已暂停');
  l = await log();
  const n1 = l.length;
  const cancelled = l.at(-1)?.kind === 'cancel' || l.at(-2)?.kind === 'cancel';
  await sleep(600);
  const n2 = (await log()).length;
  const heldPid = await evaluate(`document.querySelector('.para.speaking')?.dataset.pid`);
  await clickSel('[data-testid=speech-toggle]');
  const p2 = await waitFor(`document.querySelector('[data-testid=speech-bar]')?.textContent.includes('朗读中') && document.querySelector('[data-testid=speech-toggle]')?.textContent`, 2000, '继续');
  l = await log();
  step('暂停：cancel、不再 speak、段落高亮保留；继续：接着念', p1 === '继续' && cancelled && n2 === n1 && heldPid === nextPid && p2 === '暂停' && lastSpeak(l)?.rate === 1.2, { p1, p2, heldPid });

  // 9. 停止
  await clickSel('[data-testid=speech-stop]');
  await waitFor(`!document.querySelector('[data-testid=speech-bar]')`, 2000, '朗读条消失');
  l = await log();
  const n3 = l.length;
  await sleep(500);
  const noMore = (await log()).length === n3;
  const noHl = await evaluate(`!document.querySelector('.para.speaking')`);
  step('停止：朗读条消失、高亮清掉、cancel 后没有新的 speak', l.at(-1)?.kind === 'cancel' && noMore && noHl);

  // 10. 最后一段读完自动停（章末）
  const lastPid = await evaluate(`[...document.querySelectorAll('article .para[data-pid]')].at(-1).dataset.pid`);
  await clickSel(`.para[data-pid="${lastPid}"] .say`);
  await waitFor(`document.querySelector('.para.speaking')?.dataset.pid === ${JSON.stringify(lastPid)}`, 3000, '读最后一段');
  await waitFor(`!document.querySelector('[data-testid=speech-bar]') && !document.querySelector('.para.speaking')`, 15000, '章末自动停');
  l = await log();
  const ends = l.filter((x) => x.kind === 'end').length;
  step('从最后一段开始读 → 读完自动停（到章末不往下）', ends > 0 && l.at(-1)?.kind === 'end', { lastPid });

  // 11. 设置页：声音下拉 + 默认倍速；去设置页时朗读停
  await clickSel(`.para[data-pid="${target.pid}"] .say`);
  await waitFor(`!!document.querySelector('[data-testid=speech-bar]')`, 3000, '再开朗读');
  await clickSel('header button[aria-label="设置"]');
  await waitFor(`document.querySelector('header h1')?.textContent === '设置'`, 5000, '设置页');
  l = await log();
  const n4 = l.length;
  await sleep(600);
  const stoppedOnLeave = l.at(-1)?.kind === 'cancel' && (await log()).length === n4;
  step('朗读中去设置页 → 朗读停（cancel 且没有新 speak）', stoppedOnLeave);
  const sel = await waitFor(`(() => { const s = document.querySelector('[data-test=voice]'); return s && { options: [...s.options].map((o) => o.textContent), value: s.value }; })()`, 5000, '声音下拉');
  step('设置页声音下拉：自动项写着会用 Google UK English Female，列出 4 个英文声音、按优先级排、没有中文声音', sel.value === '' && sel.options[0].includes('Google UK English Female') && sel.options.slice(1).join('|') === 'Google UK English Female · en-GB|Google UK English Male · en-GB|English United Kingdom · en_GB|Google US English · en-US', sel);
  await evaluate(`(() => { const s = document.querySelector('[data-test=speech-rate]'); s.selectedIndex = 2; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); return s.value; })()`);
  await evaluate(`(() => { const s = document.querySelector('[data-test=voice]'); s.selectedIndex = 2; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); return s.value; })()`);
  await clickSel('form button[type=submit]');
  await waitFor(`document.body.textContent.includes('已保存')`, 3000, '已保存');
  const saved = await evaluate(`new Promise((res) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const q = r.result.transaction('settings').objectStore('settings').get('app'); q.onsuccess = () => res({ speechRate: q.result.speechRate, voiceURI: q.result.voiceURI, hasKey: typeof q.result.apiKey === 'string' }); }; })`);
  const autoLabel = await evaluate(`document.querySelector('[data-test=voice] option').textContent`);
  step('选 Google UK English Male + 1.2x → 保存 → 库里 speechRate=1.2、voiceURI 对、自动项跟着显示 Male', saved.speechRate === 1.2 && saved.voiceURI === 'Google UK English Male' && saved.hasKey && autoLabel.includes('Google UK English Male'), { saved, autoLabel });
  await evaluate(`document.querySelector('[data-test=speech]').scrollIntoView({ block: 'center' }); true`);
  await sleep(200);
  await shot(path.join(OUT, 'speech-settings.png'));

  // 12. 回阅读页：新设置生效（倍速 1.2、声音 Male）
  await clickSel('header button[aria-label="返回阅读"]');
  await waitFor(`document.querySelectorAll('article .para[data-pid]').length > 0`, 10000, '回阅读页');
  await sleep(500);
  await clickSel(`.para[data-pid="${target.pid}"] .say`);
  const bar2 = await waitFor(`document.querySelector('[data-testid=speech-bar]')?.textContent.replace(/\\s+/g, ' ')`, 3000, '朗读条');
  l = await log();
  step('回阅读页再朗读：默认倍速 1.2x、用设置里选的 Google UK English Male', bar2.includes('1.2x') && lastSpeak(l)?.rate === 1.2 && lastSpeak(l)?.voice === 'Google UK English Male', { bar2, last: lastSpeak(l) });
  await clickSel('[data-testid=speech-stop]');

  step('页面 0 报错', report.errors.length === 0, report.errors.slice(0, 5));
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  console.error(e);
  try {
    await shot(path.join(OUT, 'speech-data', 'fail.png'));
  } catch {}
} finally {
  try {
    report.ttsLog = await log();
  } catch {}
  report.allPass = !report.fatal && report.steps.every((s) => s.pass);
  writeFileSync(path.join(OUT, 'speech-data', 'browser.json'), JSON.stringify(report, null, 2));
  console.log(report.allPass ? '\n全部通过' : '\n有没过的', '→', path.join(OUT, 'speech-data', 'browser.json'));
  ws?.close();
  proc.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  process.exit(report.allPass ? 0 : 1);
}
