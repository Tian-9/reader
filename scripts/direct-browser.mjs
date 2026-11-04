// 直连模式验收（headless Chrome，CDP，390px）：真构建产物（base=/reader/）+ 真 service worker + 真 CSP + 真 Anthropic 请求。
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/direct-browser.mjs [http://localhost:4173/reader/] [--epub books/peter-pan.epub] [--out shots] [--budget 0.5]
//
// 走一遍：打开 → manifest 能取、scope/start_url 对 → service worker 在 /reader/ 下注册并接管 → 断网刷新能开
// → 设置页填 key（从 ~/.config/reader/key 读，CDP 打字进密码框，不打印、不写报告）→ "测一下"真发一次 → 截 direct-settings.png
// → 导入彼得潘 → 真标注请求 → 生词虚线出现 → 截 direct-annotate.png → 账本求和（超 --budget 记"超预算"）。
// 全程记：发往 api.anthropic.com 的请求状态码和 CORS 头、CSP 违规、页面报错、有没有连别的第三方。
// 临时 Chrome 配置（IndexedDB 里存着 key）跑完就删。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BASE = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'http://localhost:4173/reader/';
const EPUB = path.resolve(opt('--epub', 'books/peter-pan.epub'));
const OUT = path.resolve(opt('--out', 'shots'));
const BUDGET = Number(opt('--budget', '0.5'));
const KEY_FILE = path.join(os.homedir(), '.config/reader/key');
mkdirSync(path.join(OUT, 'direct-data'), { recursive: true });

const KEY = (process.env.ANTHROPIC_API_KEY || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8') : '')).trim();
if (!KEY) {
  console.error('没有 key（ANTHROPIC_API_KEY 或 ~/.config/reader/key）');
  process.exit(2);
}
/** 报告里任何地方出现 key 都抹掉（双保险）。 */
const scrub = (s) => String(s).split(KEY).join('<key>');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, steps: [], api: [], otherHosts: [], csp: [], errors: [] };
const step = (name, pass, detail) => {
  report.steps.push({ name, pass, detail });
  console.log(scrub(`${pass ? '过' : '不过'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : ''}`));
};

// ───────── CDP ─────────
const profile = mkdtempSync(path.join(os.tmpdir(), 'direct-chrome-'));
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
    await sleep(200);
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
const ledgerUsd = () =>
  evaluate(`new Promise((res) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const db = r.result; const q = db.transaction('ledger').objectStore('ledger').getAll(); q.onsuccess = () => { db.close(); res(q.result.map((x) => ({ purpose: x.purpose, model: x.model, usd: x.usd }))); }; }; r.onerror = () => res([]); })`);

const origin = new URL(BASE).origin;
let exitCode = 0;
try {
  await connect();
  handlers.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') report.errors.push(scrub(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') report.errors.push(scrub(m.params.args.map((a) => a.value ?? a.description).join(' ')));
    if (m.method === 'Log.entryAdded' && /Content Security Policy/i.test(m.params.entry.text)) report.csp.push(m.params.entry.text);
    if (m.method === 'Network.requestWillBeSent') {
      const u = new URL(m.params.request.url);
      if (!['http:', 'https:'].includes(u.protocol) || u.origin === origin || u.host === 'api.anthropic.com') return;
      report.otherHosts.push(u.origin);
    }
    if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith('https://api.anthropic.com/')) {
      const h = Object.fromEntries(Object.entries(m.params.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
      report.api.push({ url: m.params.response.url, status: m.params.response.status, acao: h['access-control-allow-origin'] ?? null, type: m.params.type });
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Log.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('securitypolicyviolation', (e) => console.error('CSP 违规', e.violatedDirective, e.blockedURI));` });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // 1. 打开
  await send('Page.navigate', { url: BASE });
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读'`, 20000, '首页');
  const cspMeta = await evaluate(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null`);
  const robots = await evaluate(`document.querySelector('meta[name=robots]')?.content ?? null`);
  step('页面打开，CSP meta 和 noindex 都在', !!cspMeta?.includes('connect-src \'self\' https://api.anthropic.com') && !!robots?.includes('noindex'), { cspMeta, robots });

  // 2. manifest（加到主屏幕用的）
  const am = await send('Page.getAppManifest');
  let mf = {};
  try { mf = JSON.parse(am.data ?? '{}'); } catch {}
  const icons = await evaluate(`Promise.all(${JSON.stringify((mf.icons ?? []).map((i) => i.src))}.map((s) => fetch(new URL(s, ${JSON.stringify(am.url)})).then((r) => r.status)))`);
  step('manifest：能取、scope/start_url = /reader/、图标都 200、无解析错误',
    am.url?.endsWith('/reader/manifest.webmanifest') && mf.scope === '/reader/' && mf.start_url === '/reader/' && mf.display === 'standalone' && icons.every((s) => s === 200) && !(am.errors ?? []).length,
    { url: am.url, scope: mf.scope, start_url: mf.start_url, id: mf.id, display: mf.display, icons, errors: am.errors });

  // 3. service worker
  const sw = await waitFor(`navigator.serviceWorker.ready.then((r) => ({ scope: r.scope, script: r.active?.scriptURL }))`, 20000, 'SW ready');
  await send('Page.reload');
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读'`);
  const controlled = await waitFor(`!!navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL`, 10000, 'SW 接管');
  step('service worker 在 /reader/ 下注册并接管页面', sw.scope === `${origin}/reader/` && sw.script === `${origin}/reader/sw.js` && !!controlled, { ...sw, controller: controlled });

  // 4. 断网能开
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.reload');
  const offlineOk = await waitFor(`document.querySelector('header h1')?.textContent === '阅读' && navigator.onLine === false`, 15000, '断网打开').catch(() => false);
  step('断网刷新能打开（service worker 缓存的外壳）', !!offlineOk);
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.reload');
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读'`);

  // 5. 设置页填 key → 测一下（真请求）
  await clickSel('button[aria-label="设置"]');
  await clickSel('input[data-test="api-key"]');
  await send('Input.insertText', { text: KEY });
  const inputType = await evaluate(`document.querySelector('input[data-test="api-key"]').type`);
  await clickSel('button[data-test="ping"]');
  const pingText = await waitFor(`(() => { const t = document.querySelector('[data-test="ping-result"]')?.textContent; return t && !t.includes('测试中') ? t : null; })()`, 60000, '测一下结果');
  const stored = await evaluate(`new Promise((res) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const q = r.result.transaction('settings').objectStore('settings').get('app'); q.onsuccess = () => { r.result.close(); res({ hasKey: (q.result?.apiKey ?? '').length > 20, hasLegacyToken: 'appToken' in (q.result ?? {}) }); }; }; })`);
  await evaluate(`document.activeElement?.blur(); scrollTo(0, 0); true`);
  await sleep(300);
  await shot(path.join(OUT, 'direct-settings.png'));
  step('设置页填 key → 测一下：真请求通了，key 存进本地 IndexedDB（密码框）', pingText.startsWith('通了') && inputType === 'password' && stored.hasKey, { pingText, inputType, stored });

  // 6. 导入彼得潘 → 真标注
  await clickSel('button[aria-label="返回阅读"]');
  await waitFor(`!!document.querySelector('input[type=file]')`, 10000, '导入按钮');
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [EPUB] });
  const paras = await waitFor(`document.querySelectorAll('article .para[data-pid]').length`, 30000, '段落');
  step('导入彼得潘 → 阅读页出段落', paras > 10, { paras });
  const vocab = await waitFor(`(CSS.highlights.get('rd-vocab')?.size ?? 0) || 0`, 180000, '生词虚线（真标注）');
  const marks = await evaluate(`document.querySelectorAll('.rd-marks .mark').length`);
  await sleep(800);
  await shot(path.join(OUT, 'direct-annotate.png'));
  step('真标注回来，生词虚线出现', vocab > 0, { vocabRanges: vocab, funMarks: marks });

  // 7. 花费 + 网络
  await sleep(1500);
  const ledger = await ledgerUsd();
  const usd = ledger.reduce((a, x) => a + x.usd, 0);
  report.ledger = ledger;
  report.usd = usd;
  step(`花费 ≤ $${BUDGET}`, usd <= BUDGET, { usd: Number(usd.toFixed(5)), calls: ledger.length });
  const posts = report.api.filter((a) => a.type !== 'Preflight');
  step('浏览器直连 api.anthropic.com：全是 200，带 CORS 头', posts.length > 0 && posts.every((a) => a.status === 200 && !!a.acao), { requests: report.api.length, statuses: report.api.map((a) => `${a.type}:${a.status}`), acao: [...new Set(report.api.map((a) => a.acao))] });
  step('没连任何别的第三方', report.otherHosts.length === 0, [...new Set(report.otherHosts)]);
  step('0 次 CSP 违规、0 个页面报错', report.csp.length === 0 && report.errors.length === 0, { csp: report.csp.slice(0, 3), errors: report.errors.slice(0, 3) });
} catch (e) {
  step('脚本中断', false, scrub(e.message));
  exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  proc.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true }); // 里面的 IndexedDB 存着 key
  const out = scrub(JSON.stringify(report, null, 2));
  writeFileSync(path.join(OUT, 'direct-data', 'browser.json'), out);
  const all = report.steps.every((s) => s.pass);
  console.log(`\n${all ? '全过' : '有不过的'}：${report.steps.filter((s) => s.pass).length}/${report.steps.length}，明细 ${path.relative(process.cwd(), path.join(OUT, 'direct-data', 'browser.json'))}`);
  process.exit(all ? exitCode : 1);
}
