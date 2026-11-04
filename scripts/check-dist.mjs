#!/usr/bin/env node
// 版权红线：dist/ 是要部署到公网的目录，里面绝不能有 .epub。
// npm run build 前后各跑一次：
//   --before  构建前：dist/ 里残留了书就直接停（提醒先删掉，别指望 vite 清目录替你兜底）
//   默认      构建后：public/ 或 import 把书带进产物 → 构建失败
// 部署前单独跑也行：node scripts/check-dist.mjs
import { readdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'dist';
const before = process.argv.includes('--before');

// EPUB 是 zip，规范要求第一个条目是不压缩的 mimetype 文件，所以第 30 字节起固定是这串
const MAGIC = Buffer.from('mimetypeapplication/epub+zip');

/** 文件头是不是 EPUB（防止改了扩展名混进来）。 */
function looksLikeEpub(path) {
  const buf = Buffer.alloc(30 + MAGIC.length);
  const fd = openSync(path, 'r');
  try {
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n === buf.length && buf[0] === 0x50 && buf[1] === 0x4b && buf.subarray(30).equals(MAGIC);
  } finally {
    closeSync(fd);
  }
}

/** 递归找电子书：扩展名 .epub（大小写不敏感）或文件头是 EPUB。 */
function findEpubs(root) {
  const out = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...findEpubs(p));
    else if (/\.epub$/i.test(e.name) || looksLikeEpub(p)) out.push(p);
  }
  return out;
}

if (!existsSync(dir)) {
  if (!before) {
    console.error('check-dist: 找不到 dist/，构建没产出？');
    process.exit(1);
  }
  process.exit(0);
}

const hits = findEpubs(dir);
if (hits.length) {
  console.error(`\n✗ check-dist${before ? '（构建前）' : ''}: dist/ 里发现电子书文件，构建失败。书只能存在手机本地，不能进部署目录：`);
  for (const h of hits) console.error(`   ${h}`);
  console.error('  删掉这些文件（并检查 public/ 和 import），再重新 npm run build。\n');
  process.exit(1);
}
if (!before) console.log('✓ check-dist: dist/ 里没有 .epub');
