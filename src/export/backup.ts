/**
 * 词库备份（PLAN 2.5 兜底 / T5）：整个 words 表 + 设置 → 一个 JSON；导入时按 lemma 合并，导入的覆盖同 lemma。
 *
 * - **备份里不带 API key（apiKey，也不带遗留的 appToken）**：备份文件会进下载目录、可能发给 Claude 会话，key 一漏别人就能花她的额度。
 *   导入时保留本机当前的 key；清空站点数据后导入，key 要重新填一次。
 * - 书、标注、聊天、账本不进备份（书有版权、其余能重新生成）。
 */
import type { ReaderDB } from '../db/db';
import { normLemma } from '../annotate/words';
import { normalizeSettings } from '../settings.svelte';
import type { Settings, Word, WordStatus } from '../types';

export interface Backup {
  format: 'reader-backup';
  version: 1;
  exportedAt: number;
  words: Word[];
  settings: Omit<Settings, 'apiKey' | 'appToken'>;
}

export async function buildBackup(d: ReaderDB): Promise<Backup> {
  const words = await d.words.toArray();
  const row = await d.settings.get('app');
  const { key: _k, apiKey: _a, appToken: _t, ...rest } = row ?? { key: 'app' as const, ...normalizeSettings(undefined) };
  return { format: 'reader-backup', version: 1, exportedAt: Date.now(), words, settings: rest };
}

const STATUSES: WordStatus[] = ['known', 'learning', 'unknown'];

/** 读文件前的形状检查：不对就抛中文错误，库一行都不动。 */
export function parseBackup(text: string): Backup {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('这个文件不是 JSON，选错文件了？');
  }
  if (Array.isArray(o)) throw new Error('这是"导出生词"的文件（给背单词页用的），不是词库备份。');
  const b = o as Partial<Backup> | null;
  if (!b || b.format !== 'reader-backup') throw new Error('不是阅读器的词库备份文件。');
  if (b.version !== 1) throw new Error(`备份版本 ${String(b.version)} 认不出来，可能是新版 App 导出的。`);
  if (!Array.isArray(b.words)) throw new Error('备份文件坏了：没有 words。');
  for (const w of b.words) {
    if (!w || typeof w.lemma !== 'string' || !normLemma(w.lemma) || !STATUSES.includes(w.status)) {
      throw new Error('备份文件坏了：有一条词的 lemma 或状态不对。');
    }
  }
  return b as Backup;
}

export interface ImportResult {
  /** 文件里的词数 */
  imported: number;
  /** 其中本机原来已有（被覆盖）的 */
  replaced: number;
  /** 导入后词库总数 */
  total: number;
}

/**
 * 合并导入：同 lemma 用备份里的整行覆盖，备份里没有的本机词保留。设置用备份覆盖，API key 保留本机的（keepKey）。
 * 一个事务里做完，中途出错整个回滚。
 */
export async function importBackup(d: ReaderDB, b: Backup, keepKey?: string): Promise<ImportResult> {
  return d.transaction('rw', d.words, d.settings, async () => {
    // 规范化后同 lemma 的，后出现的赢（和"导入的覆盖"同一个规矩）
    const byLemma = new Map<string, Word>();
    for (const w of b.words) byLemma.set(normLemma(w.lemma), { ...w, lemma: normLemma(w.lemma) });
    const rows = [...byLemma.values()];
    const existing = await d.words.bulkGet(rows.map((w) => w.lemma));
    await d.words.bulkPut(rows);
    const cur = await d.settings.get('app');
    const { apiKey: _a, appToken: _t, ...incoming } = (b.settings ?? {}) as Partial<Settings>;
    const merged = normalizeSettings({ ...(cur ?? {}), ...incoming });
    merged.apiKey = keepKey ?? cur?.apiKey ?? '';
    await d.settings.put({ key: 'app', ...merged });
    return { imported: rows.length, replaced: existing.filter(Boolean).length, total: await d.words.count() };
  });
}
