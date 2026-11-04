#!/usr/bin/env node
// 按 schema 校验阅读器导出的 JSON（PLAN T5）。
//
//   node scripts/validate-export.mjs 生词.json [备份.json …]
//
// 自动认两种文件：
// - 生词导出：数组，每条是背单词页 words 集合的形状 {en, zh, lesson, cluster, key, gloss_zh, context_zh, root, mishearing, mnemonic}
//   en / zh 必填非空；其余是字符串（可空）；不许多字段；lesson 形如 "PeterPan-ch03"；en ≤5 个词；en 不重复。
//   版权红线：除 en 外任何字段里出现 ≥6 个连续英文词 → 不过（"不带英文原句"）。
// - 词库备份：{format:"reader-backup", version:1, exportedAt, words:[…], settings:{…}}，settings 里不许有 apiKey / appToken。
//
// 和 app 里的导出代码是两份独立实现（故意的），test/export.test.ts 拿 app 的导出结果过这里。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const VOCAB_FIELDS = ['en', 'zh', 'lesson', 'cluster', 'key', 'gloss_zh', 'context_zh', 'root', 'mishearing', 'mnemonic'];
const LESSON_RE = /^[A-Za-z0-9]+(-ch\d{2,})?$/;
const STATUSES = ['known', 'learning', 'unknown'];

/** 文本里最长的一串连续英文词有几个词（标点、空格隔开都算连着）。 */
export function longestEnglishRun(s) {
  let best = 0;
  for (const m of s.matchAll(/[A-Za-z][A-Za-z'’-]*(?:[\s,;:.!?"“”()]+[A-Za-z][A-Za-z'’-]*)*/g)) {
    const n = m[0].split(/[^A-Za-z'’-]+/).filter((w) => /[A-Za-z]/.test(w)).length;
    if (n > best) best = n;
  }
  return best;
}

const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/** 生词导出。返回错误列表，空 = 过。 */
export function validateVocab(data) {
  const errs = [];
  if (!Array.isArray(data)) return ['顶层必须是数组'];
  const seen = new Set();
  data.forEach((row, i) => {
    const at = `第 ${i + 1} 条`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return errs.push(`${at}：不是对象`);
    for (const k of Object.keys(row)) if (!VOCAB_FIELDS.includes(k)) errs.push(`${at}：多了字段 ${k}`);
    for (const k of VOCAB_FIELDS) {
      if (k in row && typeof row[k] !== 'string') errs.push(`${at}：${k} 不是字符串`);
    }
    for (const k of ['en', 'zh']) {
      if (typeof row[k] !== 'string' || !row[k].trim()) errs.push(`${at}：${k} 必填`);
    }
    if (typeof row.en === 'string' && row.en.trim()) {
      if (wordCount(row.en) > 5) errs.push(`${at}：en 超过 5 个词（${wordCount(row.en)}）`);
      if (!/[A-Za-z]/.test(row.en)) errs.push(`${at}：en 里没有英文字母`);
      const key = row.en.trim().toLowerCase();
      if (seen.has(key)) errs.push(`${at}：en 重复（${row.en}）`);
      seen.add(key);
    }
    if (typeof row.lesson === 'string' && row.lesson && !LESSON_RE.test(row.lesson)) errs.push(`${at}：lesson 格式不对（${row.lesson}）`);
    for (const k of VOCAB_FIELDS) {
      if (k === 'en' || k === 'lesson' || typeof row[k] !== 'string') continue;
      const n = longestEnglishRun(row[k]);
      if (n >= 6) errs.push(`${at}：${k} 里有 ${n} 个连续英文词（不许带英文原句）`);
    }
  });
  return errs;
}

/** 词库备份。 */
export function validateBackup(data) {
  const errs = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['顶层必须是对象'];
  if (data.format !== 'reader-backup') errs.push('format 必须是 "reader-backup"');
  if (data.version !== 1) errs.push('version 必须是 1');
  if (typeof data.exportedAt !== 'number') errs.push('exportedAt 必须是时间戳');
  if (!Array.isArray(data.words)) errs.push('words 必须是数组');
  else {
    const seen = new Set();
    data.words.forEach((w, i) => {
      const at = `words 第 ${i + 1} 条`;
      if (!w || typeof w !== 'object') return errs.push(`${at}：不是对象`);
      if (typeof w.lemma !== 'string' || !w.lemma.trim()) errs.push(`${at}：lemma 必填`);
      else if (seen.has(w.lemma)) errs.push(`${at}：lemma 重复（${w.lemma}）`);
      else seen.add(w.lemma);
      if (!STATUSES.includes(w.status)) errs.push(`${at}：status 不对（${w.status}）`);
    });
  }
  if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) errs.push('settings 必须是对象');
  else {
    if ('apiKey' in data.settings) errs.push('settings 里不许带 apiKey（备份文件会到处传）');
    if ('appToken' in data.settings) errs.push('settings 里不许带 appToken（备份文件会到处传）');
  }
  return errs;
}

/** 认文件类型并校验。 */
export function validateExport(data) {
  if (Array.isArray(data)) return { kind: 'vocab', errors: validateVocab(data), count: data.length };
  if (data && data.format === 'reader-backup') return { kind: 'backup', errors: validateBackup(data), count: Array.isArray(data.words) ? data.words.length : 0 };
  return { kind: 'unknown', errors: ['认不出来：既不是生词导出（数组）也不是词库备份（format: reader-backup）'], count: 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法：node scripts/validate-export.mjs 文件.json [...]');
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    let r;
    try {
      r = validateExport(JSON.parse(readFileSync(f, 'utf8')));
    } catch (e) {
      r = { kind: '?', errors: [`读不了 / 不是 JSON：${e.message}`], count: 0 };
    }
    const label = r.kind === 'vocab' ? '生词导出' : r.kind === 'backup' ? '词库备份' : '未知';
    if (r.errors.length) {
      bad++;
      console.log(`不过  ${f}（${label}，${r.count} 条）`);
      for (const e of r.errors.slice(0, 50)) console.log('  - ' + e);
      if (r.errors.length > 50) console.log(`  …还有 ${r.errors.length - 50} 条`);
    } else console.log(`过  ${f}（${label}，${r.count} 条）`);
  }
  process.exit(bad ? 1 : 0);
}
