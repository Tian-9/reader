/**
 * 阅读视图的共享状态（T2 写，T3/T4 只读）。
 * - visibleParaIds：IntersectionObserver 看到的、正在屏幕上的段落（按阅读顺序）。T3 预取、T4 聊天上下文用。
 * - topParaId：屏幕最上面那段 = 存进 progress 的位置。
 */
export const reading = $state({
  bookId: '',
  chapter: 0,
  visibleParaIds: [] as string[],
  topParaId: '',
});

/** 点词事件 'word-tap' 的 detail（和 types.ts 里 T3 的 WordTapDetail 同形状）。start/end 是段内偏移 [start, end)。 */
export interface WordTap {
  paraId: string;
  start: number;
  end: number;
  surface: string;
}

export const WORD_TAP_EVENT = 'word-tap';
