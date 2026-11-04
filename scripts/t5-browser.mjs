// T5 浏览器验收（headless Chrome，CDP 驱动，390px 手机宽）：真实构建产物，不调 API。
//
//   npm run build && npx vite preview --port 4173 &      # 先起静态预览
//   node scripts/t5-browser.mjs [http://localhost:4173/reader/] [--out shots]
//
// 走一遍：往 IndexedDB 塞一本书 + 词库 + 账本 → 设置页：花费面板和账本求和对账（< $0.001）、持久存储状态、截 t5-settings.png
// → 点"导出生词"，下载的文件过 scripts/validate-export.mjs → 点"备份词库"，备份也过校验
// → Storage.clearDataForOrigin 清空站点数据（等于她在浏览器里"清除网站数据"）→ 刷新，词库是 0
// → 设置页"从备份恢复"选那个文件 → 词库条数和清空前一致、设置恢复。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateExport } from './validate-export.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BASE = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'http://localhost:4173/reader/';
const OUT = path.resolve(opt('--out', 'shots'));
mkdirSync(path.join(OUT, 't5-data'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, steps: [], errors: [] };
const step = (name, pass, detail) => {
  report.steps.push({ name, pass, detail });
  console.log(`${pass ? '过' : '不过'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : ''}`);
};

// ───────── 种子数据（自编，不含任何书的原文） ─────────
const BOOK = 'bk-t5';
const now = Date.now();
const G = ['翻找', '横着', '咕哝', '瞪着', '溜走', '叹气', '发抖', '闲逛', '嘀咕', '偷看', '踮脚', '哄骗', '咯咯笑', '打盹', '扑腾'];
const STATUSES = ['known', 'learning', 'unknown'];
const WORDS = Array.from({ length: 33 }, (_, i) => ({
  lemma: `word${String(i).padStart(2, '0')}`,
  status: STATUSES[i % 3],
  source: 'tapped',
  glossZh: i === 31 || i === 32 ? '' : G[i % G.length],
  firstSeen: { bookId: BOOK, paraId: `c${String(1 + (i % 9)).padStart(2, '0')}p${String(i + 1).padStart(4, '0')}` },
  taps: 1 + (i % 4),
  updatedAt: now - i * 1000,
}));
const L = (purpose, model, usd, n) => Array.from({ length: n }, (_, i) => ({ ts: now - i * 60000, bookId: BOOK, purpose, model, input: 1500, output: 900, cacheRead: 2700, cacheWrite: 0, usd: usd * (1 + (i % 5) * 0.137) }));
const LEDGER = [
  ...L('annotate', 'claude-haiku-5-5', 0.00312, 14),
  ...L('annotate', 'claude-sonnet-5-5', 0.0391, 3),
  ...L('tap', 'claude-haiku-5-5', 0.000231, 9),
  ...L('summary', 'claude-haiku-5-5', 0.00041, 8),
  ...L('chat', 'claude-sonnet-5-5', 0.0187, 11),
  ...L('chat', 'claude-opus-5-5', 0.0362, 2),
  { ts: now, purpose: 'chat', model: 'claude-haiku-5-5', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, usd: 0.00002 }, // 没挂书（设置页"测一下"）
];

// ───────── CDP ─────────
const profile = mkdtempSync(path.join(os.tmpdir(), 't5-chrome-'));
const downloads = mkdtempSync(path.join(os.tmpdir(), 't5-dl-'));
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
async function waitDownload(prefix, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = readdirSync(downloads).find((n) => n.startsWith(prefix) && n.endsWith('.json'));
    if (f) {
      await sleep(200);
      return path.join(downloads, f);
    }
    await sleep(150);
  }
  throw new Error(`等不到下载：${prefix}`);
}
/** 直接读 IndexedDB（不经过 App 代码）：某张表的全部行。 */
const idbAll = (store) =>
  evaluate(`new Promise((res, rej) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains(${JSON.stringify(store)})) { db.close(); return res([]); } const q = db.transaction(${JSON.stringify(store)}).objectStore(${JSON.stringify(store)}).getAll(); q.onsuccess = () => { db.close(); res(q.result); }; q.onerror = () => rej(q.error); }; r.onerror = () => rej(r.error); })`);
const idbPut = (store, rows) =>
  evaluate(`new Promise((res, rej) => { const r = indexedDB.open('reader'); r.onsuccess = () => { const db = r.result; const tx = db.transaction(${JSON.stringify(store)}, 'readwrite'); for (const row of ${JSON.stringify(rows)}) tx.objectStore(${JSON.stringify(store)}).put(row); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); })`);
const toSettings = async () => {
  await clickSel('header button.icon');
  await waitFor(`document.querySelector('header h1')?.textContent === '设置' && !!document.querySelector('[data-test=word-counts]')`, 10000, '设置页');
  await sleep(300);
};

try {
  await connect();
  handlers.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') report.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.setBypassServiceWorker', { bypass: true }).catch(() => {});
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }).catch(() =>
    send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }),
  );
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  // 1. 打开（App 建好库），塞种子数据，刷新
  await send('Page.navigate', { url: BASE });
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读'`);
  await sleep(300);
  await idbPut('settings', [{ key: 'app', apiKey: 'mock-key-not-real', level: 'B2', noSpoilers: true, models: { chat: 'claude-opus-5-5' }, readSize: 22 }]);
  await idbPut('books', [{ id: BOOK, title: 'Peter Pan', author: 'J. M. Barrie', addedAt: now - 86400000 }]);
  await idbPut('progress', [{ bookId: BOOK, paraId: 'c03p0002', updatedAt: now }]);
  await idbPut('summaries', [1, 2].map((chapter) => ({ bookId: BOOK, chapter, textZh: '（自编摘要）', model: 'claude-haiku-5-5' })));
  await idbPut('words', WORDS);
  await idbPut('ledger', LEDGER);
  await send('Page.reload');
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读'`);

  // 2. 设置页：花费面板对账
  await toSettings();
  const ledger = await idbAll('ledger');
  const bookSum = ledger.filter((r) => r.bookId === BOOK).reduce((s, r) => s + r.usd, 0);
  const allSum = ledger.reduce((s, r) => s + r.usd, 0);
  const panel = await evaluate(`(() => {
    const total = document.querySelector('[data-test=spend-total]')?.textContent;
    const groups = [...document.querySelectorAll('[data-test=spend] tr.grp')].map((tr) => ({ purpose: tr.dataset.purpose, usd: tr.querySelector('.usd').textContent }));
    return { total, groups, text: document.querySelector('[data-test=spend]').innerText };
  })()`);
  const shown = Number(panel.total.replace(/[<$]/g, ''));
  step('花费面板"本书已花"= 账本求和（误差 < $0.001）', Math.abs(shown - bookSum) < 0.001, { shown: panel.total, ledgerSum: bookSum.toFixed(6), diff: Math.abs(shown - bookSum).toFixed(6) });
  const groupOk = panel.groups.every((g) => {
    const s = ledger.filter((r) => r.bookId === BOOK && r.purpose === g.purpose).reduce((a, r) => a + r.usd, 0);
    return Math.abs(Number(g.usd.replace(/[<$]/g, '')) - s) < 0.001;
  });
  step('按用途分组的小计也和账本对得上', groupOk && panel.groups.map((g) => g.purpose).join() === 'annotate,tap,summary,chat', panel.groups);
  step('所有书合计（含没挂书的）显示', panel.text.includes(`所有书合计 $${allSum.toFixed(3)}`), { allSum: allSum.toFixed(6) });
  const persist = await evaluate(`document.querySelector('[data-test=persist]')?.textContent.trim()`);
  step('设置页显示持久存储申请结果', /已申请持久存储：(是|否|浏览器不支持)/.test(persist), persist);
  const counts0 = await evaluate(`document.querySelector('[data-test=word-counts]').textContent`);
  step('词库计数', counts0.includes('认识 11') && counts0.includes('在学 11') && counts0.includes('不认识 11'), counts0);

  // 截图：整页（设置页比一屏长）
  await evaluate('window.scrollTo(0, 0)');
  const h = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 390, height: h, scale: 1 } });
  writeFileSync(path.join(OUT, 't5-settings.png'), Buffer.from(s.data, 'base64'));
  const vw = await evaluate('document.documentElement.scrollWidth');
  step('390px 下不横向溢出', vw <= 390, { scrollWidth: vw, height: h });

  // 3. 导出生词 → 过校验
  await clickSel('[data-test=export-vocab]');
  const vocabFile = await waitDownload('生词-');
  const vocab = JSON.parse(readFileSync(vocabFile, 'utf8'));
  const v = validateExport(vocab);
  const expected = WORDS.filter((w) => w.status !== 'known' && w.glossZh).length;
  step('导出生词：文件过 validate-export.mjs', v.kind === 'vocab' && v.errors.length === 0 && vocab.length === expected, { count: vocab.length, expected, errors: v.errors.slice(0, 3), first: vocab[0] });
  step('导出提示里说了没释义的', (await evaluate(`document.querySelector('[data-test=vocab-msg]')?.textContent`))?.includes('没有中文释义'));

  // 4. 备份
  await clickSel('[data-test=backup]');
  const backupFile = await waitDownload('词库备份-');
  const backup = JSON.parse(readFileSync(backupFile, 'utf8'));
  const b = validateExport(backup);
  step('备份文件过校验、不含 API key', b.kind === 'backup' && b.errors.length === 0 && !readFileSync(backupFile, 'utf8').includes('mock-key-not-real'), { words: backup.words.length, errors: b.errors.slice(0, 3) });
  const before = (await idbAll('words')).length;

  // 5. 清空站点数据
  const origin = new URL(BASE).origin;
  await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await send('Page.reload');
  await waitFor(`document.querySelector('header h1')?.textContent === '阅读'`);
  await sleep(500);
  const afterClear = (await idbAll('words')).length;
  const tokenAfterClear = (await idbAll('settings'))[0]?.apiKey ?? '';
  step('清空站点数据后词库为 0', afterClear === 0 && tokenAfterClear === '', { before, afterClear });

  // 6. 从备份恢复
  await toSettings();
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[data-test=restore]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [backupFile] });
  const msg = await waitFor(`(() => { const t = document.querySelector('[data-test=vocab-msg]')?.textContent; return t && t.includes('导入了') ? t : null; })()`, 10000, '导入提示');
  const restored = await idbAll('words');
  const settingsRow = (await idbAll('settings'))[0];
  const counts1 = await evaluate(`document.querySelector('[data-test=word-counts]').textContent`);
  step('导入备份后词库条数和清空前一致', restored.length === before && counts1 === counts0, { before, after: restored.length, msg, counts: counts1 });
  step('设置也恢复了（水平、防剧透、聊天模型、字号）', settingsRow?.level === 'B2' && settingsRow?.noSpoilers === true && settingsRow?.models?.chat === 'claude-opus-5-5' && settingsRow?.readSize === 22, settingsRow && { ...settingsRow, apiKey: settingsRow.apiKey ? '(有)' : '(空)' });
  const same = WORDS.every((w) => {
    const r = restored.find((x) => x.lemma === w.lemma);
    return r && r.status === w.status && r.glossZh === w.glossZh && r.taps === w.taps;
  });
  step('恢复的每个词状态/释义/点击数和原来一样', same);

  step('页面 0 报错', report.errors.length === 0, report.errors.slice(0, 5));
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  console.error(e);
  try {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, 't5-data', 'fail.png'), Buffer.from(s.data, 'base64'));
  } catch {}
} finally {
  report.allPass = !report.fatal && report.steps.every((s) => s.pass);
  writeFileSync(path.join(OUT, 't5-data', 'browser.json'), JSON.stringify(report, null, 2));
  console.log(report.allPass ? '\n全部通过' : '\n有没过的', '→', path.join(OUT, 't5-data', 'browser.json'));
  ws?.close();
  proc.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
  process.exit(report.allPass ? 0 : 1);
}
