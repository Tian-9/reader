// 本地截图：起一个 headless Chrome，经 CDP（Chrome 调试协议）按手机宽度截整页。
// 用法：node scripts/t3-shot.mjs <url> <out.png> [width=390] [scale=1] [jsBeforeShot]
// 不依赖 puppeteer：Node 24 自带 WebSocket。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function shoot(url, out, { width = 390, scale = 1, before = '', wait = 400 } = {}) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 't3-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {}
    }
    if (!target) throw new Error('Chrome 没起来');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) events.push(msg);
    };
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: scale, mobile: true });
    await send('Page.navigate', { url });
    for (let i = 0; i < 100 && !events.some((e) => e.method === 'Page.loadEventFired'); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, wait));
    let value;
    if (before) {
      const r = await send('Runtime.evaluate', { expression: before, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('页面脚本出错：' + JSON.stringify(r.exceptionDetails));
      value = r.result?.value;
      await new Promise((r) => setTimeout(r, wait));
    }
    const { result } = await send('Runtime.evaluate', { expression: 'Math.ceil(document.documentElement.scrollHeight)', returnByValue: true });
    const height = Math.max(200, result.value);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: true });
    await new Promise((r) => setTimeout(r, 150));
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    ws.close();
    return { height, value, errors: errs.map((e) => JSON.stringify(e.params).slice(0, 300)) };
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 200));
    rmSync(profile, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , url, out, width, scale, before] = process.argv;
  const r = await shoot(url, out, { width: Number(width ?? 390), scale: Number(scale ?? 1), before: before ?? '' });
  console.log(JSON.stringify(r));
}
