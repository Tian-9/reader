/**
 * 花费面板（PLAN T5）："本书已花 $x"，按用途和模型分组，数字全部从 ledger 表求和。
 * 纯函数 + 一个读库的薄壳，单测核对"面板显示的数 = 账本逐行相加"，误差 < $0.001。
 */
import type { ReaderDB } from '../db/db';
import type { LedgerEntry, Purpose } from '../types';

export const PURPOSE_LABEL: Record<Purpose, string> = {
  annotate: '标注',
  tap: '补注',
  summary: '摘要',
  chat: '聊天',
};
export const PURPOSE_ORDER: Purpose[] = ['annotate', 'tap', 'summary', 'chat'];

export interface SpendLine {
  model: string;
  calls: number;
  usd: number;
  /** 命中缓存的输入 token（看缓存好不好使） */
  cacheRead: number;
}

export interface SpendGroup {
  purpose: Purpose;
  label: string;
  calls: number;
  usd: number;
  models: SpendLine[];
}

export interface SpendSummary {
  calls: number;
  usd: number;
  groups: SpendGroup[];
  /** 按模型合计（不分用途） */
  byModel: SpendLine[];
}

export function summarizeSpend(rows: LedgerEntry[]): SpendSummary {
  const groups = new Map<Purpose, Map<string, SpendLine>>();
  const byModel = new Map<string, SpendLine>();
  let usd = 0;
  const add = (m: Map<string, SpendLine>, r: LedgerEntry) => {
    const l = m.get(r.model) ?? { model: r.model, calls: 0, usd: 0, cacheRead: 0 };
    l.calls++;
    l.usd += r.usd;
    l.cacheRead += r.cacheRead;
    m.set(r.model, l);
  };
  for (const r of rows) {
    usd += r.usd;
    let g = groups.get(r.purpose);
    if (!g) groups.set(r.purpose, (g = new Map()));
    add(g, r);
    add(byModel, r);
  }
  const byUsd = (a: SpendLine, b: SpendLine) => b.usd - a.usd || a.model.localeCompare(b.model);
  const known = PURPOSE_ORDER.filter((p) => groups.has(p));
  const other = [...groups.keys()].filter((p) => !PURPOSE_ORDER.includes(p));
  return {
    calls: rows.length,
    usd,
    groups: [...known, ...other].map((p) => {
      const models = [...groups.get(p)!.values()].sort(byUsd);
      return {
        purpose: p,
        label: PURPOSE_LABEL[p] ?? p,
        calls: models.reduce((s, l) => s + l.calls, 0),
        usd: models.reduce((s, l) => s + l.usd, 0),
        models,
      };
    }),
    byModel: [...byModel.values()].sort(byUsd),
  };
}

/** 某本书的花费；bookId 不给 = 全部（含没挂书的，比如"测一下口令"）。 */
export async function spendFor(d: ReaderDB, bookId?: string): Promise<SpendSummary> {
  const rows = bookId ? await d.ledger.where('bookId').equals(bookId).toArray() : await d.ledger.toArray();
  return summarizeSpend(rows);
}

/**
 * 面板上的美元写法：固定 3 位小数（$0.123）。
 * PLAN 写的是 "$x.xx"，但两位小数四舍五入最多差 $0.005，过不了"误差 < $0.001"的验收，所以多留一位。
 * 不到千分之一但不是 0 的写 "<$0.001"，免得她以为没花钱。
 */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.0005) return '<$0.001';
  return '$' + usd.toFixed(3);
}

/** 模型 id 的短名："claude-sonnet-5-5" → "Sonnet 5.5"。 */
export function modelShort(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : id;
}
