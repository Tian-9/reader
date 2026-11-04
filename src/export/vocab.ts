/**
 * 生词导出（PLAN T5）：words 表里 status 是 learning / unknown 的词 → 背单词页（vocab-trainer）`words` 集合的形状。
 *
 * 版权红线（PLAN 第 4 节）：只导出词、中文释义、中文语境说明，**不带英文原句**。
 * 所以 quote / 段落原文一律不进文件；context_zh 目前只写"第 N 章"（真正的场景描述要再调一次模型，MVP 不做）。
 * scripts/validate-export.mjs 按同一份 schema 校验，还会拦"中文字段里夹了 ≥6 个连续英文词"。
 */
import type { ReaderDB } from '../db/db';
import { isCommonWord } from '../annotate/visible';
import { normLemma } from '../annotate/words';
import { parseParaId, type Annotation, type Book, type ReaderLevel, type Word } from '../types';

/** 一条导出的生词。只有 en 和 zh 必填（非空），其余字段都在、可以是空串。 */
export interface VocabExportRow {
  en: string;
  zh: string;
  /** 形如 "PeterPan-ch03"：书名缩写 + 第一次遇到的章 */
  lesson: string;
  cluster: string;
  key: string;
  gloss_zh: string;
  context_zh: string;
  root: string;
  mishearing: string;
  mnemonic: string;
}

export const VOCAB_FIELDS: (keyof VocabExportRow)[] = [
  'en', 'zh', 'lesson', 'cluster', 'key', 'gloss_zh', 'context_zh', 'root', 'mishearing', 'mnemonic',
];

const STOP = new Set(['the', 'a', 'an']);

/** 书名 → lesson 前缀：只留 ASCII 字母数字，按词首字母大写拼起来，去掉开头的冠词，最长 24 字符。"Peter Pan" → "PeterPan"。 */
export function lessonPrefix(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && STOP.has(words[0]!.toLowerCase())) words.shift();
  const s = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('').slice(0, 24);
  return s || 'Book';
}

export function lessonOf(prefix: string, chapter: number | null): string {
  return chapter ? `${prefix}-ch${String(chapter).padStart(2, '0')}` : prefix;
}

export interface VocabExport {
  rows: VocabExportRow[];
  /** 没有中文释义、导不了的 lemma（zh 是必填） */
  skipped: string[];
}

/**
 * 从库里拼导出。释义优先用 words.glossZh，没有就找同 lemma 的 vocab 标注（优先第一次遇到的那段）；
 * gloss_zh 放标注的 note_zh（补充说明，和 zh 一样就不重复）。按第一次遇到的位置排序（书 → 章 → 段）。
 */
export async function buildVocabExport(d: ReaderDB, level?: ReaderLevel): Promise<VocabExport> {
  // 常用词表里的词（多半是误点卡片记下的 unknown）不导出；她自己加进生词本的照导
  const words = ((await d.words.where('status').anyOf('learning', 'unknown').toArray()) as Word[]).filter(
    (w) => w.status === 'learning' || !level || !isCommonWord(w.lemma, level),
  );
  const books = new Map<string, Book>((await d.books.toArray()).map((b) => [b.id, b]));
  const anns = new Map<string, Annotation[]>();
  if (words.length) {
    const wanted = new Set(words.map((w) => w.lemma));
    await d.annotations.each((a) => {
      if (a.kind !== 'vocab') return;
      const l = normLemma(a.lemma);
      if (!wanted.has(l)) return;
      const list = anns.get(l);
      if (list) list.push(a);
      else anns.set(l, [a]);
    });
  }

  const order = (w: Word) => {
    const p = parseParaId(w.firstSeen?.paraId ?? '');
    return [books.get(w.firstSeen?.bookId)?.addedAt ?? 0, p?.chapter ?? 0, p?.idx ?? 0] as const;
  };
  words.sort((a, b) => {
    const x = order(a), y = order(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.lemma.localeCompare(b.lemma);
  });

  const rows: VocabExportRow[] = [];
  const skipped: string[] = [];
  for (const w of words) {
    const list = anns.get(w.lemma) ?? [];
    const ann =
      list.find((a) => a.bookId === w.firstSeen?.bookId && a.paraId === w.firstSeen?.paraId) ??
      list.filter((a) => a.glossZh).sort((a, b) => a.createdAt - b.createdAt)[0];
    const zh = (w.glossZh || ann?.glossZh || '').trim();
    if (!zh) {
      skipped.push(w.lemma);
      continue;
    }
    const note = (ann?.noteZh ?? '').trim();
    const chapter = parseParaId(w.firstSeen?.paraId ?? '')?.chapter ?? null;
    const book = books.get(w.firstSeen?.bookId);
    rows.push({
      en: w.lemma,
      zh,
      lesson: lessonOf(lessonPrefix(book?.title ?? ''), chapter),
      cluster: '',
      key: '',
      gloss_zh: note && note !== zh ? note : '',
      context_zh: chapter ? `第 ${chapter} 章` : '',
      root: '',
      mishearing: '',
      mnemonic: '',
    });
  }
  return { rows, skipped };
}
