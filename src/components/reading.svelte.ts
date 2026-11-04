/**
 * 阅读视图的共享状态（T2 写，T3/T4 只读）。
 * - visibleParaIds：IntersectionObserver 看到的、正在屏幕上的段落（按阅读顺序）。T3 预取、T4 聊天上下文用。
 * - topParaId：屏幕最上面那段 = 存进 progress 的位置。
 * - chapterVocab：本章显示出来的生词（T3 写，目录面板读）。
 */
export const reading = $state({
  bookId: '',
  chapter: 0,
  visibleParaIds: [] as string[],
  topParaId: '',
  /** 2026-11-04 补：本章当前显示出来的生词（T3 标注层写，目录面板的"本章生词"读），按出现顺序、同 lemma 只留第一处 */
  chapterVocab: [] as ChapterVocabItem[],
});

export interface ChapterVocabItem {
  id: string;
  paraId: string;
  lemma: string;
  quote: string;
  glossZh: string;
}

/** 目录面板点了某条生词：标注层滚过去之后闪一下那个词（detail = 标注 id） */
export const FOCUS_ANNOTATION_EVENT = 'focus-annotation';

/** 点词事件 'word-tap' 的 detail（和 types.ts 里 T3 的 WordTapDetail 同形状）。start/end 是段内偏移 [start, end)。 */
export interface WordTap {
  paraId: string;
  start: number;
  end: number;
  surface: string;
}

export const WORD_TAP_EVENT = 'word-tap';
