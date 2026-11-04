/**
 * 花费账本：每次 API 调用记一行（purpose / model / tokens / usd）。T3 的标注、点词在用，T4/T5 照用。
 */
import type { ReaderDB } from '../db/db';
import type { LedgerEntry, Purpose } from '../types';
import { costUsd, type UsageLike } from './pricing';

export async function recordUsage(
  d: ReaderDB,
  e: { purpose: Purpose; model: string; usage: UsageLike; bookId?: string },
): Promise<LedgerEntry> {
  const row: LedgerEntry = {
    ts: Date.now(),
    bookId: e.bookId,
    purpose: e.purpose,
    model: e.model,
    input: e.usage.input_tokens,
    output: e.usage.output_tokens,
    cacheRead: e.usage.cache_read_input_tokens ?? 0,
    cacheWrite: e.usage.cache_creation_input_tokens ?? 0,
    usd: costUsd(e.model, e.usage),
  };
  row.id = await d.ledger.add(row);
  return row;
}

/** 某本书（或全部）一共花了多少美元。 */
export async function totalUsd(d: ReaderDB, bookId?: string): Promise<number> {
  const rows = bookId ? await d.ledger.where('bookId').equals(bookId).toArray() : await d.ledger.toArray();
  return rows.reduce((s, r) => s + r.usd, 0);
}
