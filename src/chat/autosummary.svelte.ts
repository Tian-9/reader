/**
 * 读完一章自动生成前情摘要（接线部分）。在阅读页的组件初始化时调用 useAutoSummary()。
 * 判断逻辑在 summary.ts 的 summaryToTrigger（有单测），这里只负责盯着 reading 状态、取本章段落、后台跑。
 */
import { getAnnotator } from '../annotate/queue';
import { chapterParas, db } from '../db/db';
import { reading } from '../components/reading.svelte';
import { settings } from '../settings.svelte';
import { Summarizer, summaryToTrigger } from './summary';

let shared: Summarizer | null = null;

/** 全局唯一的摘要器（和标注器共用同一个 ctx：同一个库、同一个走代理的 create、同一份设置）。 */
export function getSummarizer(): Summarizer {
  shared ??= new Summarizer(getAnnotator(() => settings).ctx);
  return shared;
}

export function useAutoSummary(): void {
  const summarizer = getSummarizer();
  let loadedKey = '';
  let paraIds: string[] = [];
  let title = '';
  let done = new Set<number>();

  async function check(bookId: string, chapter: number, visible: string[]) {
    const key = `${bookId}|${chapter}`;
    if (key !== loadedKey) {
      const d = db();
      const [paras, ch, dn] = await Promise.all([
        chapterParas(d, bookId, chapter),
        d.chapters.get([bookId, chapter]),
        summarizer.doneChapters(d, bookId),
      ]);
      loadedKey = key;
      paraIds = paras.map((p) => p.id);
      title = ch?.title ?? `第${chapter}章`;
      done = dn;
    }
    const n = summaryToTrigger({ chapter, chapterParaIds: paraIds, visibleParaIds: visible, done, hasToken: !!settings.apiKey.trim() });
    if (n === null) return;
    done.add(n);
    summarizer.ensure(bookId, n, title).catch((e) => {
      done.delete(n); // 失败了下次读到章末再试
      console.warn('[summary] 生成失败', e);
    });
  }

  $effect(() => {
    const bookId = reading.bookId;
    const chapter = reading.chapter;
    const visible = [...reading.visibleParaIds];
    if (!bookId || !chapter) return;
    void check(bookId, chapter, visible);
  });
}
