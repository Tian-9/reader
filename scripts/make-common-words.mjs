// 生成 src/annotate/common-words.ts（常用词表，标注的"常用词闸"用）。
//
// 数据：New General Service List 1.2（NGSL，Browne, C., Culligan, B., & Phillips, J.），CC BY-SA 4.0。
//   https://www.newgeneralservicelist.com/new-general-service-list
//   下载 NGSL_12_stats.csv（按频率排名的 2809 个 lemma）、NGSL_12_lemmatized_for_teaching.csv（每个 lemma 的词形，含英式拼写）
//   和 SUP_lemmatized.csv（星期、月份、数字等补充词），放进同一个目录：
//     curl -sLO https://www.newgeneralservicelist.com/s/NGSL_12_stats.csv
//     curl -sLO https://www.newgeneralservicelist.com/s/NGSL_12_lemmatized_for_teaching.csv
//     curl -sLO https://www.newgeneralservicelist.com/s/SUP_lemmatized.csv
//   node scripts/make-common-words.mjs <那个目录>
//
// 生成的文件是 NGSL 的改编版（只取 lemma 和排名、转小写），按 CC BY-SA 4.0 继续以同一许可证发布。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node scripts/make-common-words.mjs <放 NGSL_12_stats.csv 和 SUP_lemmatized.csv 的目录>');
  process.exit(2);
}
const strip = (s) => s.replace(/^﻿/, '').trim();

const stats = readFileSync(path.join(dir, 'NGSL_12_stats.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
const ranked = stats
  .map((l) => l.split(','))
  .map(([lemma, rank]) => ({ lemma: strip(lemma).toLowerCase(), rank: Number(rank) }))
  .filter((x) => x.lemma && Number.isFinite(x.rank))
  .sort((a, b) => a.rank - b.rank);
const seen = new Set();
const ngsl = [];
for (const { lemma } of ranked) {
  if (seen.has(lemma)) continue;
  if (!/^[a-z][a-z'-]*$/.test(lemma)) throw new Error(`NGSL 里有奇怪的 lemma：${lemma}`);
  seen.add(lemma);
  ngsl.push(lemma);
}
const sup = readFileSync(path.join(dir, 'SUP_lemmatized.csv'), 'utf8')
  .split(/\r?\n/)
  .map((l) => strip(l.split(',')[0] ?? '').toLowerCase())
  .filter((w) => w && !seen.has(w));

// 词形表：只收"规则词尾推不出来"的（不规则复数/过去式、英式拼写），规则的交给 visible.ts 的 lookupForms
const regular = (l) => {
  const r = new Set([l, l + 's', l + 'es', l + 'ed', l + 'd', l + 'ing', l + 'er', l + 'ers', l + 'est', l + 'ly']);
  if (l.endsWith('y')) for (const x of ['ies', 'ied', 'ier', 'iest', 'ily']) r.add(l.slice(0, -1) + x);
  if (l.endsWith('e')) for (const x of ['ing', 'r', 'st']) r.add((x === 'ing' ? l.slice(0, -1) : l) + x);
  const c = l.at(-1);
  for (const x of ['ed', 'ing', 'er', 'est']) r.add(l + c + x);
  return r;
};
const forms = new Map();
for (const line of readFileSync(path.join(dir, 'NGSL_12_lemmatized_for_teaching.csv'), 'utf8').split(/\r?\n/)) {
  if (!line.trim() || line.startsWith('##')) continue;
  const [lemma, ...fs] = line.split(',').map((x) => strip(x).toLowerCase()).filter(Boolean);
  if (!lemma || !seen.has(lemma)) continue;
  const reg = regular(lemma);
  for (const f of fs) {
    if (f.length < 3 || !/^[a-z]+$/.test(f) || reg.has(f) || seen.has(f) || forms.has(f)) continue;
    forms.set(f, lemma);
  }
}

const out = `/**
 * 常用词表（标注的"常用词闸"用，查表逻辑在 visible.ts）。由 scripts/make-common-words.mjs 生成，别手改。
 *
 * 数据来源：New General Service List 1.2（NGSL）
 *   Browne, C., Culligan, B., & Phillips, J. — https://www.newgeneralservicelist.com/
 *   许可证：Creative Commons Attribution-ShareAlike 4.0 International（CC BY-SA 4.0）
 *   https://creativecommons.org/licenses/by-sa/4.0/
 * 本文件是 NGSL 的改编版（只取 lemma、按频率排名排序、转小写；Excel 改坏的 TRUE/FALSE 还原成小写），
 * 按 CC BY-SA 4.0 以同一许可证发布（仅本文件，不影响仓库其他代码）。
 *
 * NGSL：${ngsl.length} 个 lemma，按频率从高到低，空格分隔（美式拼写，查表时 visible.ts 会试英式→美式变体）。
 * SUP：NGSL 的补充表（星期、月份、数字），${sup.length} 个，任何水平都算常用。
 * FORMS：规则词尾推不出来的词形 → lemma（children:child、went:go、colour:color…），${forms.size} 个，来自 NGSL 的 teaching 版词形表。
 */
export const NGSL = ${JSON.stringify(ngsl.join(' '))};

export const NGSL_SUPPLEMENT = ${JSON.stringify(sup.join(' '))};

export const NGSL_FORMS = ${JSON.stringify([...forms].map(([f, l]) => `${f}:${l}`).join(' '))};
`;
const target = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/annotate/common-words.ts');
writeFileSync(target, out);
console.log(`写好 ${target}：NGSL ${ngsl.length} 个 + 补充 ${sup.length} 个 + 词形 ${forms.size} 个，${(Buffer.byteLength(out) / 1024).toFixed(1)} KB`);
