<script lang="ts">
  // 标注层（T3）：叠在 T2 的阅读视图上，不改 T2 的 DOM。
  //
  // - 生词：用 CSS Custom Highlight API（浏览器自带的"给一段文字上样式而不插标签"）画虚线下划线
  // - "有意思"：在段落右侧页边放一个小 ※，点它打开小注
  // - 监听 T2 派发的 'word-tap'（冒泡到 window）：点到已标的词 → 开卡片；点到没标的词 → 点词补注
  // - currentParaId 变了 → 预取（k、k+1 等着，k+2 后台）；已标过的不再请求
  //
  // 对 T2 的要求：每段的元素能用 paraElement(root, id) 找到（默认 T2 的 [data-pid="c01p0001"]，也认 data-para-id），
  // 元素里所有文字节点按顺序拼起来 = para.text（T2 的 ParaText 正是这样）。页边记号画在段落外的浮层里，不往段落里塞元素。
  import { liveQuery } from 'dexie';
  import { onMount } from 'svelte';
  import { getAnnotator, pillState, type Annotator } from '../annotate/queue';
  import { tapAnnotate, annotationAt } from '../annotate/tap';
  import { chapterVocabList, hiddenReason, isVisible } from '../annotate/visible';
  import { addToLearning, lemmaSets, levelAbove, markKnown, noteTapped, normLemma, thresholdHint, unmarkKnown, type ThresholdHint } from '../annotate/words';
  import { db } from '../db/db';
  import { saveSettings, settings } from '../settings.svelte';
  import type { Annotation, AskXiaokeDetail, ChunkRow, Word, WordTapDetail } from '../types';
  import { FOCUS_ANNOTATION_EVENT, reading } from './reading.svelte';
  import WordCard, { type CardState } from './WordCard.svelte';

  let {
    bookId,
    root,
    paraIds,
    currentParaId = '',
    visibleParaIds = undefined,
    paraText = undefined,
    publishChapterVocab = false,
    paraElement = (r: HTMLElement, id: string) => r.querySelector<HTMLElement>(`[data-pid="${id}"], [data-para-id="${id}"]`),
    annotator = getAnnotator(() => settings),
  }: {
    bookId: string;
    /** 包含段落元素的容器（T2 的阅读视图） */
    root: HTMLElement | undefined;
    /** 当前渲染出来的段落（通常是这一章） */
    paraIds: string[];
    /** 读到哪一段（触发预取） */
    currentParaId?: string;
    /** 屏幕上看得见的段落（决定小牌子是"标注中…"还是"预取下一段"）；不给就只看 currentParaId */
    visibleParaIds?: string[];
    /** 段落原文（专有名词闸判断句首用） */
    paraText?: (paraId: string) => string | undefined;
    /** 把本章显示的生词写进 reading.chapterVocab（阅读页开，demo 不开） */
    publishChapterVocab?: boolean;
    paraElement?: (root: HTMLElement, paraId: string) => HTMLElement | null;
    annotator?: Annotator;
  } = $props();

  let anns: Annotation[] = $state([]);
  let words: Word[] = $state([]);
  let card: CardState | null = $state(null);
  let hint: ThresholdHint | null = $state(null);
  let toast = $state('');
  /** k、k+1 里还没标好的组（ensureAround 报上来的） */
  let pending: ChunkRow[] = $state([]);
  /** 目录面板点过来的那条，闪一下 */
  let flashId = $state('');
  let overlay: HTMLDivElement | undefined = $state();
  let marks: { id: string; top: number; left: number; ann: Annotation }[] = $state([]);

  // ── 数据：本章标注 + 词库（liveQuery：库一变就自动刷新，点"我会"立刻生效） ──
  $effect(() => {
    const keys = paraIds.map((p) => [bookId, p] as [string, string]);
    const sub = liveQuery(() => (keys.length ? db().annotations.where('[bookId+paraId]').anyOf(keys).toArray() : [])).subscribe({
      next: (v) => (anns = v),
      error: (e) => console.error('读标注失败', e),
    });
    return () => sub.unsubscribe();
  });
  $effect(() => {
    const sub = liveQuery(() => db().words.toArray()).subscribe({
      next: (v) => (words = v),
      error: (e) => console.error('读词库失败', e),
    });
    return () => sub.unsubscribe();
  });

  const sets = $derived(lemmaSets(words));
  const visible = $derived(
    anns.filter((a) => isVisible(a, settings.level, sets.known, sets.marked, { paraText, learning: sets.learning })),
  );
  const pill = $derived(pillState(pending, visibleParaIds?.length ? visibleParaIds : [currentParaId]));

  $effect(() => {
    if (!publishChapterVocab) return;
    reading.chapterVocab = chapterVocabList(visible).map((a) => ({ id: a.id, paraId: a.paraId, lemma: a.lemma, quote: a.quote, glossZh: a.glossZh }));
    return () => (reading.chapterVocab = []);
  });
  const wordStatus = $derived.by(() => {
    const a = card?.ann;
    return a ? words.find((w) => w.lemma === normLemma(a.lemma))?.status : undefined;
  });

  // ── 画：Highlight API + 页边记号 ──
  const supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  function rangeFor(el: HTMLElement, start: number, end: number): Range | null {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let pos = 0;
    let gotStart = false;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const len = n.data.length;
      if (!gotStart && start < pos + len) {
        r.setStart(n, start - pos);
        gotStart = true;
      }
      if (gotStart && end <= pos + len) {
        r.setEnd(n, end - pos);
        return r;
      }
      pos += len;
    }
    return null;
  }

  function paint() {
    if (!root) return;
    const vocab: Range[] = [];
    const active: Range[] = [];
    const nextMarks: typeof marks = [];
    const box = overlay?.getBoundingClientRect();
    const seenLine = new Set<string>();
    for (const a of visible) {
      const el = paraElement(root, a.paraId);
      if (!el) continue;
      const r = rangeFor(el, a.start, a.end);
      if (!r) continue;
      if (a.kind === 'vocab') vocab.push(r);
      if (card?.ann?.id === a.id || flashId === a.id) active.push(r);
      if (a.kind === 'fun' && box) {
        const line = r.getClientRects()[0];
        const pr = el.getBoundingClientRect();
        if (line) {
          const top = Math.round(line.top - box.top);
          const key = `${a.paraId}@${top}`;
          // 同一行有两条 fun 就往下错开一点，别叠在一起
          const nudge = seenLine.has(key) ? 14 : 0;
          seenLine.add(key);
          nextMarks.push({ id: a.id, ann: a, top: top + nudge, left: Math.round(pr.right - box.left + 2) });
        }
      }
    }
    if (card?.ann && card.ann.kind === 'vocab' && !visible.some((v) => v.id === card!.ann!.id)) {
      const el = paraElement(root, card.ann.paraId);
      const r = el && rangeFor(el, card.ann.start, card.ann.end);
      if (r) active.push(r);
    }
    marks = nextMarks;
    if (supported) {
      CSS.highlights.set('rd-vocab', new Highlight(...vocab));
      CSS.highlights.set('rd-active', new Highlight(...active));
    }
  }

  let raf = 0;
  function schedulePaint() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(paint);
  }

  $effect(() => {
    // 依赖：可见标注、打开的卡片、容器
    void visible;
    void card?.ann?.id;
    void flashId;
    void root;
    schedulePaint();
  });

  onMount(() => {
    const style = document.createElement('style');
    style.dataset.t3 = 'highlights';
    style.textContent = `
      ::highlight(rd-vocab) { text-decoration: underline dashed; text-decoration-color: var(--accent); text-decoration-thickness: 1.5px; text-underline-offset: 0.24em; }
      ::highlight(rd-active) { background-color: color-mix(in srgb, var(--accent) 22%, transparent); }`;
    document.head.append(style);
    const onTap = (e: Event) => void handleTap((e as CustomEvent<WordTapDetail>).detail);
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const onFocus = (e: Event) => {
      flashId = String((e as CustomEvent<string>).detail ?? '');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => (flashId = ''), 1600);
    };
    window.addEventListener('word-tap', onTap);
    window.addEventListener(FOCUS_ANNOTATION_EVENT, onFocus);
    window.addEventListener('resize', schedulePaint);
    return () => {
      style.remove();
      clearTimeout(flashTimer);
      window.removeEventListener('word-tap', onTap);
      window.removeEventListener(FOCUS_ANNOTATION_EVENT, onFocus);
      window.removeEventListener('resize', schedulePaint);
      if (supported) {
        CSS.highlights.delete('rd-vocab');
        CSS.highlights.delete('rd-active');
      }
    };
  });

  // T2 重新渲染段落（换章、改字号）时重画
  $effect(() => {
    if (!root) return;
    const mo = new MutationObserver(schedulePaint);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(schedulePaint);
    ro.observe(root);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  });

  // ── 预取 ──
  let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  let prefetchToken = 0;
  $effect(() => {
    const pid = currentParaId;
    const b = bookId;
    if (!pid || !b) return;
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(async () => {
      // 只认最新一次的回报：往回滚/快速翻时，旧的那次后报上来的状态别把新的盖掉
      const token = ++prefetchToken;
      try {
        await annotator.ensureAround(b, pid, (p) => {
          if (token === prefetchToken) pending = p;
        });
      } catch (e) {
        if (token === prefetchToken) pending = [];
        toast = `标注没成功：${e instanceof Error ? e.message : String(e)}`;
      }
    }, 300);
    return () => clearTimeout(prefetchTimer);
  });

  // ── 点词 ──
  function open(a: Annotation) {
    card = { surface: a.quote, ann: a, loading: false };
    const lemma = normLemma(a.lemma);
    // 被常用词/专有名词闸藏起来的词：卡片照开，但不记进词库（她自己加过生词本的除外）
    const gated = !sets.learning.has(lemma) && !!hiddenReason(a, settings.level, paraText?.(a.paraId));
    if (a.kind === 'vocab' && !gated && !sets.known.has(lemma)) {
      void noteTapped(db(), { lemma: a.lemma, level: a.level, glossZh: a.glossZh, bookId: a.bookId, paraId: a.paraId });
    }
  }

  async function handleTap(t: WordTapDetail) {
    if (!t || !/[\p{L}]/u.test(t.surface)) return;
    const hit = annotationAt(anns, t.paraId, t.start, t.end);
    if (hit) return open(hit);
    card = { surface: t.surface, loading: true };
    try {
      const para = await db().paras.get([bookId, t.paraId]);
      if (!para) throw new Error('找不到这一段');
      const ann = await tapAnnotate(annotator.ctx, bookId, para, t);
      if (card?.surface === t.surface) card = { surface: t.surface, ann, loading: false };
    } catch (e) {
      if (card?.surface === t.surface) card = { surface: t.surface, loading: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const wordInput = () => {
    const a = card!.ann!;
    return { lemma: a.lemma, level: a.level, glossZh: a.glossZh, bookId: a.bookId, paraId: a.paraId };
  };

  async function onknown() {
    if (!card?.ann) return;
    await markKnown(db(), wordInput());
    card = null;
    hint = thresholdHint(await db().words.toArray(), settings.level);
  }
  async function onunknown() {
    if (card?.ann) await unmarkKnown(db(), wordInput());
  }
  async function onlearn() {
    if (card?.ann) await addToLearning(db(), wordInput());
  }
  function onask(el: HTMLElement) {
    const a = card?.ann;
    if (!a) return;
    const detail: AskXiaokeDetail = {
      bookId: a.bookId,
      paraId: a.paraId,
      quote: a.quote,
      kind: a.kind,
      lemma: a.lemma,
      glossZh: a.glossZh,
      noteZh: a.noteZh,
      annotationId: a.id,
    };
    el.dispatchEvent(new CustomEvent('ask-xiaoke', { detail, bubbles: true, composed: true }));
    card = null;
  }

  async function acceptHint() {
    if (!hint) return;
    settings.level = hint.suggest;
    hint = null;
    await saveSettings();
  }
</script>

<div class="rd-marks" bind:this={overlay} aria-hidden={marks.length === 0}>
  {#each marks as m (m.id)}
    <button class="mark" style:top="{m.top}px" style:left="{m.left}px" aria-label="有意思：{m.ann.funType}" onclick={() => open(m.ann)}>※</button>
  {/each}
</div>

{#if pill === 'current'}
  <div class="pill" aria-live="polite">标注中…</div>
{:else if pill === 'prefetch'}
  <div class="pill quiet" data-testid="prefetch-pill">预取下一段</div>
{/if}

{#if hint}
  <div class="toast" role="status">
    <p>{hint.level} 的词你已经连着点了 {hint.count} 次"我会"。要不要把水平调到 {hint.suggest}？以后只标 {levelAbove(hint.suggest)} 及以上的。</p>
    <div class="row">
      <button class="primary" onclick={acceptHint}>调到 {hint.suggest}</button>
      <button onclick={() => (hint = null)}>先不用</button>
    </div>
  </div>
{:else if toast}
  <div class="toast" role="status">
    <p>{toast}</p>
    <div class="row"><button onclick={() => (toast = '')}>知道了</button></div>
  </div>
{/if}

{#if card}
  <WordCard {card} status={wordStatus} onclose={() => (card = null)} {onknown} {onunknown} {onlearn} {onask} />
{/if}

<style>
  .rd-marks {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .mark {
    position: absolute;
    pointer-events: auto;
    min-height: 0;
    width: 22px;
    height: 22px;
    margin-top: -1px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--accent);
    font-size: 13px;
    line-height: 22px;
    text-align: center;
  }
  .pill {
    position: fixed;
    z-index: 20;
    right: 12px;
    bottom: calc(12px + env(safe-area-inset-bottom));
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--card);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 12px;
  }
  /* 预取下一段：当前看的都标好了，只是在后台等下一组。小字、没边框，不抢眼 */
  .pill.quiet {
    padding: 2px 6px;
    background: transparent;
    border-color: transparent;
    font-size: 11px;
    opacity: 0.6;
    pointer-events: none;
  }
  .toast {
    position: fixed;
    z-index: 25;
    left: 12px;
    right: 12px;
    bottom: calc(12px + env(safe-area-inset-bottom));
    max-width: 640px;
    margin: 0 auto;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    box-shadow: 0 4px 18px rgb(0 0 0 / 0.12);
    font-size: 14px;
    line-height: 1.5;
  }
  .toast p {
    margin: 0 0 8px;
  }
  .row {
    display: flex;
    gap: 8px;
  }
</style>
