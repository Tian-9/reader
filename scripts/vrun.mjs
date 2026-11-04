// 用 vite 的 SSR 模块加载跑一个 TS 脚本（项目里没有 tsx；src/ 里的无扩展名 import 靠 vite 解析）。
// 用法：node scripts/vrun.mjs scripts/t3-real.ts [参数…]   脚本要 export async function main(args: string[])
// 只给本地开发脚本用，不进 dist（vite build 的入口是根目录 index.html）。
import path from 'node:path';
import { createServer } from 'vite';

const [, , entry, ...args] = process.argv;
if (!entry) {
  console.error('用法：node scripts/vrun.mjs <script.ts> [args…]');
  process.exit(2);
}
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
let code = 0;
try {
  const mod = await server.ssrLoadModule(path.resolve(entry));
  await mod.main(args);
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await server.close();
}
process.exit(code);
