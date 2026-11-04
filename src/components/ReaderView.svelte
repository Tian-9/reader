<script lang="ts">
  // 阅读视图（T2）：一次渲染一章，竖向滚动。
  // - 进度：IntersectionObserver 看哪些段在屏幕上，最上面那段存进 progress；重开回到那段。
  // - 字号、行距：工具条上的 Aa，存进 settings。
  // - 点词：给出 {paraId, start, end, surface}，console.log + 冒泡派发 CustomEvent('word-tap')，也可以传 onwordtap。
  // 给 T3 留的口子：paraContent snippet（换掉段内渲染，画标注）、afterPara snippet（段后挂东西，比如页边记号）。
  import { onDestroy, tick, type Snippet } from 'svelte';
  import { chapterParas, db } from '../db/db';
  import { touchProgress, type ImportResult } from '../epub/import';
  import { wordAt } from '../epub/words';
  import { saveSettings, settings } from '../settings.svelte';
  import { parseParaId, type Book, type ChapterRow, type ParaRow } from '../types';
  import AnnotationLayer from './AnnotationLayer.svelte';
  import ImportButton from './ImportButton.svelte';
  import ParaText from './ParaText.svelte';
  import { reading, WORD_TAP_EVENT, type WordTap } from './reading.svelte';

  let {
    bookId,
    notice = '',
    onswitchbook,
    onwordtap,
    paraContent,
    afterPara,
  }: {
    bookId: string;
    notice?: string;
    onswitchbook?: (bookId: string, r?: ImportResult) => void;
    onwordtap?: (t: WordTap) => void;
    paraContent?: Snippet<[ParaRow]>;
    afterPara?: Snippet<[ParaRow]>;
  } = $props();

  const SIZE_MIN = 14;
  const SIZE_MAX = 34;
  const LEAD_MIN = 1.3;
  const LEAD_MAX = 2.3;
  /** App 顶栏 + 本工具条，进度判断时把这块当成"屏幕外" */
  const BAR = 52;
  const TOOLBAR = 44;
  const TOP = BAR + TOOLBAR;

  let book: Book | undefined = $state();
  let chapters: ChapterRow[] = $state([]);
  let chapterN = $state(0);
  let paras: ParaRow[] = $state([]);
  let panel: 'none' | 'toc' | 'type' = $state('none');
  let books: Book[] = $state([]);
  let shownNotice = $state('');
  let loadError = $state('');

  let root: HTMLElement;
  let article: HTMLElement | undefined = $state();
  /** 恢复位置完成前，不让 IntersectionObserver 的初始回调把进度盖掉 */
  let tracking = false;

  const size = $derived(settings.readSize ?? 19);
  const leading = $derived(settings.readLeading ?? 1.7);
  const chapter = $derived(chapters.find((c) => c.n === chapterN));
  const chapterParaIds = $derived(paras.map((p) => p.id));

  $effect(() => {
    shownNotice = notice;
  });

  // ───────── 载入 ─────────

  async function load() {
    const d = db();
    const [b, chs, prog] = await Promise.all([
      d.books.get(bookId),
      d.chapters.where('bookId').equals(bookId).toArray(),
      d.progress.get(bookId),
    ]);
    if (!b || !chs.length) {
      loadError = '这本书的数据不完整，重新导入一次试试。';
      return;
    }
    book = b;
    chapters = chs.sort((x, y) => x.n - y.n);
    const pos = prog && parseParaId(prog.paraId);
    const n = pos && chapters.some((c) => c.n === pos.chapter) ? pos.chapter : chapters[0]!.n;
    await openChapter(n, prog?.paraId);
  }

  async function openChapter(n: number, anchorParaId?: string) {
    tracking = false;
    panel = 'none';
    const rows = await chapterParas(db(), bookId, n);
    chapterN = n;
    paras = rows;
    reading.bookId = bookId;
    reading.chapter = n;
    await tick();
    observeAll();
    // 停在本章第一段就回页顶（章名、提示都看得见）；否则把那段顶到工具条下面
    const el = anchorParaId && anchorParaId !== rows[0]?.id && article?.querySelector<HTMLElement>(`[data-pid="${anchorParaId}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
    // 等布局和 IO 的初始回调都过去再开始记
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    tracking = true;
    updateTop(true);
  }

  load().catch((e) => {
    console.error('[reader] 载入失败', e);
    loadError = '本地数据读不出来。';
  });

  // ───────── 可见段落 + 进度 ─────────

  const visible = new Set<string>();
  let io: IntersectionObserver | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = '';

  function observeAll() {
    io?.disconnect();
    visible.clear();
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.pid!;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        updateTop();
      },
      { rootMargin: `-${TOP}px 0px 0px 0px` },
    );
    for (const el of article?.querySelectorAll<HTMLElement>('[data-pid]') ?? []) io.observe(el);
  }

  /** 最上面那段：第一个"段首在工具条下面"的可见段；整屏只有一段的长段落就取它。 */
  function updateTop(now = false) {
    if (!tracking) return;
    const ids = [...visible].sort((a, b) => (parseParaId(a)?.idx ?? 0) - (parseParaId(b)?.idx ?? 0));
    reading.visibleParaIds = ids;
    let top = ids[0] ?? '';
    for (const id of ids) {
      const el = article?.querySelector<HTMLElement>(`[data-pid="${id}"]`);
      if (el && el.getBoundingClientRect().top >= TOP - 8) {
        top = id;
        break;
      }
    }
    if (!top) return;
    reading.topParaId = top;
    clearTimeout(saveTimer);
    if (now) void saveProgress();
    else saveTimer = setTimeout(saveProgress, 400);
  }

  async function saveProgress() {
    const id = reading.topParaId;
    if (!id || id === lastSaved || reading.bookId !== bookId) return;
    lastSaved = id;
    await db().progress.put({ bookId, paraId: id, updatedAt: Date.now() });
  }

  let raf = 0;
  function onscroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      updateTop();
    });
  }
  function flush() {
    if (document.visibilityState === 'hidden') {
      clearTimeout(saveTimer);
      void saveProgress();
    }
  }

  onDestroy(() => {
    io?.disconnect();
    clearTimeout(saveTimer);
    void saveProgress();
  });

  // ───────── 点词 ─────────

  function caretOffset(paraEl: HTMLElement, x: number, y: number): number | null {
    let node: Node | null = null;
    let off = 0;
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      node = p?.offsetNode ?? null;
      off = p?.offset ?? 0;
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      node = r?.startContainer ?? null;
      off = r?.startOffset ?? 0;
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !paraEl.contains(node)) return null;
    // 段内文字节点累加；[data-nontext] 里的（T3 的页边记号之类）不算
    const walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('[data-nontext]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let sum = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === node) return sum + off;
      sum += walker.currentNode.nodeValue?.length ?? 0;
    }
    return null;
  }

  function onclick(ev: MouseEvent) {
    if (window.getSelection()?.toString()) return; // 在选字，不算点词
    const target = ev.target as Element;
    const pEl = target.closest<HTMLElement>('[data-pid]');
    if (!pEl || target.closest('[data-nontext]')) return;
    const pid = pEl.dataset.pid!;
    const para = paras.find((p) => p.id === pid);
    if (!para) return;
    let tap: WordTap | null = null;
    const w = target.closest<HTMLElement>('[data-s]');
    if (w && pEl.contains(w)) {
      const start = Number(w.dataset.s);
      const end = Number(w.dataset.e);
      tap = { paraId: pid, start, end, surface: para.text.slice(start, end) };
    } else {
      const off = caretOffset(pEl, ev.clientX, ev.clientY);
      const t = off === null ? null : wordAt(para.text, off);
      if (t) tap = { paraId: pid, start: t.start, end: t.end, surface: t.surface };
    }
    if (!tap) return;
    console.log('[word-tap]', tap);
    onwordtap?.(tap);
    root.dispatchEvent(new CustomEvent<WordTap>(WORD_TAP_EVENT, { detail: tap, bubbles: true, composed: true }));
  }

  // ───────── 字号行距 ─────────

  let settingsTimer: ReturnType<typeof setTimeout> | undefined;
  async function setType(next: { size?: number; leading?: number }) {
    const anchor = reading.topParaId;
    tracking = false;
    if (next.size !== undefined) settings.readSize = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(next.size)));
    if (next.leading !== undefined) settings.readLeading = Math.min(LEAD_MAX, Math.max(LEAD_MIN, Math.round(next.leading * 10) / 10));
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => void saveSettings(), 300);
    await tick();
    // 改字号后留在同一段
    article?.querySelector<HTMLElement>(`[data-pid="${anchor}"]`)?.scrollIntoView({ block: 'start' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    tracking = true;
  }

  // ───────── 目录 / 换书 ─────────

  async function openToc() {
    if (panel === 'toc') {
      panel = 'none';
      return;
    }
    books = await db().books.orderBy('addedAt').toArray();
    panel = 'toc';
  }

  async function switchBook(id: string, r?: ImportResult) {
    panel = 'none';
    if (id === bookId) {
      if (r?.existed) shownNotice = '这本已经导入过了，接着上次的位置读。';
      return;
    }
    await saveProgress();
    await touchProgress(db(), id);
    onswitchbook?.(id, r);
  }

  const prev = $derived(chapters[chapters.findIndex((c) => c.n === chapterN) - 1]);
  const next = $derived(chapters[chapters.findIndex((c) => c.n === chapterN) + 1]);
</script>

<svelte:window {onscroll} />
<svelte:document onvisibilitychange={flush} />

<div class="reader" bind:this={root} style:--read-size="{size}px" style:--read-leading={leading}>
  <div class="toolbar">
    <button class="tb" aria-expanded={panel === 'toc'} onclick={openToc}>目录</button>
    <span class="ctitle">{chapter?.title ?? ''}</span>
    <button class="tb" aria-label="字号和行距" aria-expanded={panel === 'type'} onclick={() => (panel = panel === 'type' ? 'none' : 'type')}>Aa</button>
  </div>

  {#if shownNotice}
    <p class="notice" role="status">{shownNotice} <button class="x" aria-label="关掉提示" onclick={() => (shownNotice = '')}>知道了</button></p>
  {/if}
  {#if loadError}<p class="notice err">{loadError}</p>{/if}

  {#if chapter}
    <!-- 点词：事件委托到整章，键盘用户另有选词方式之前先这样 -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <article bind:this={article} lang="en" {onclick}>
      <h2 class="chead">{chapter.title}</h2>
      {#each paras as p (p.id)}
        <p class="para" data-pid={p.id}>
          {#if paraContent}{@render paraContent(p)}{:else}<ParaText text={p.text} />{/if}
        </p>
        {#if afterPara}{@render afterPara(p)}{/if}
      {/each}
      <!-- T3 标注层（T4 接线）：生词虚线用 Highlight API 画在上面的文字上，※ 画在 article 内的绝对定位浮层里 -->
      <AnnotationLayer {bookId} root={article} paraIds={chapterParaIds} currentParaId={reading.topParaId} />
    </article>
    <nav class="chapnav">
      {#if prev}<button onclick={() => openChapter(prev.n)}>← 上一章</button>{:else}<span></span>{/if}
      {#if next}<button class="primary" onclick={() => openChapter(next.n)}>下一章 →</button>{:else}<span class="muted">全书完</span>{/if}
    </nav>
  {/if}

  {#if panel !== 'none'}
    <button class="scrim" aria-label="关闭" onclick={() => (panel = 'none')}></button>
    <div class="sheet" role="dialog" aria-label={panel === 'toc' ? '目录' : '字号和行距'}>
      {#if panel === 'toc'}
        <p class="book">{book?.title}{book?.author ? ` · ${book.author}` : ''}</p>
        <ol class="toc">
          {#each chapters as c (c.n)}
            <li><button class:cur={c.n === chapterN} onclick={() => openChapter(c.n)}>{c.title}</button></li>
          {/each}
        </ol>
        {#if books.length > 1}
          <p class="sub">其他书</p>
          <ul class="toc">
            {#each books.filter((b) => b.id !== bookId) as b (b.id)}
              <li><button onclick={() => switchBook(b.id)}>{b.title}</button></li>
            {/each}
          </ul>
        {/if}
        <div class="more">
          <ImportButton label="导入另一本" primary={false} onimported={(r) => switchBook(r.bookId, r)} />
          <p class="muted small">书只存在这台手机里，不会上传。</p>
        </div>
      {:else}
        <div class="row">
          <span>字号</span>
          <button aria-label="字小一点" onclick={() => setType({ size: size - 1 })} disabled={size <= SIZE_MIN}>A−</button>
          <input type="range" min={SIZE_MIN} max={SIZE_MAX} step="1" value={size} aria-label="字号" oninput={(e) => setType({ size: Number(e.currentTarget.value) })} />
          <button aria-label="字大一点" onclick={() => setType({ size: size + 1 })} disabled={size >= SIZE_MAX}>A+</button>
          <span class="val">{size}</span>
        </div>
        <div class="row">
          <span>行距</span>
          <button aria-label="行距小一点" onclick={() => setType({ leading: leading - 0.1 })} disabled={leading <= LEAD_MIN}>−</button>
          <input type="range" min={LEAD_MIN} max={LEAD_MAX} step="0.1" value={leading} aria-label="行距" oninput={(e) => setType({ leading: Number(e.currentTarget.value) })} />
          <button aria-label="行距大一点" onclick={() => setType({ leading: leading + 0.1 })} disabled={leading >= LEAD_MAX}>+</button>
          <span class="val">{leading.toFixed(1)}</span>
        </div>
        <p class="preview" lang="en">The quick brown fox — “can’t stop,” she said.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .reader {
    /* App 的 main 有左右 padding，这里不再加 */
    margin-top: calc(-1 * var(--gutter));
  }
  .toolbar {
    position: sticky;
    top: var(--bar-h);
    z-index: 5;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 calc(-1 * var(--gutter));
    padding: 0 var(--gutter);
    background: var(--bg);
    border-bottom: 1px solid var(--line);
  }
  .tb {
    min-height: 34px;
    padding: 0 12px;
    font-size: 15px;
  }
  .ctitle {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: center;
    font-size: 14px;
    color: var(--muted);
  }
  .notice {
    margin: 12px 0 0;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--card);
    border: 1px solid var(--line);
    font-size: 14px;
    line-height: 1.6;
  }
  .notice.err { color: var(--danger); }
  .notice .x {
    min-height: 30px;
    margin-left: 6px;
    padding: 0 10px;
    font-size: 13px;
  }
  article {
    /* 标注层的 ※ 浮层以 article 为定位基准；右边留 14px 给页边 ※（22px 宽，一半伸进 main 的边距），
       不留的话 ※ 会伸出屏幕，手机上整页能左右晃 */
    position: relative;
    padding-right: 14px;
    font-family: var(--read-font);
    font-size: var(--read-size);
    line-height: var(--read-leading);
    overflow-wrap: break-word;
    /* 不断字：学英语时 ro-/mantic 这种拆开的词难认也难点 */
    hyphens: manual;
  }
  .chead {
    margin: 1.4em 0 1.2em;
    font-size: 1.15em;
    font-weight: 600;
    line-height: 1.35;
    text-align: center;
  }
  .para {
    margin: 0 0 var(--para-gap);
    scroll-margin-top: calc(var(--bar-h) + 44px);
  }
  .chapnav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin: 2.5em 0 3em;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: rgb(0 0 0 / 0.25);
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 21;
    max-height: 75dvh;
    overflow-y: auto;
    max-width: 680px;
    margin: 0 auto;
    padding: 16px var(--gutter) calc(16px + env(safe-area-inset-bottom));
    background: var(--bg);
    border-top: 1px solid var(--line);
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -6px 24px rgb(0 0 0 / 0.12);
  }
  .book {
    margin: 0 0 8px;
    font-family: var(--read-font);
    font-size: 17px;
  }
  .sub {
    margin: 14px 0 4px;
    font-size: 13px;
    color: var(--muted);
  }
  .toc {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .toc button {
    width: 100%;
    min-height: 42px;
    text-align: left;
    border: 0;
    border-radius: 8px;
    background: transparent;
    font-size: 15px;
  }
  .toc button.cur {
    background: var(--card);
    color: var(--accent);
    font-weight: 600;
  }
  .more {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--line);
    text-align: center;
  }
  .small { font-size: 13px; margin: 8px 0 0; }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0 12px;
    font-size: 15px;
  }
  .row > span:first-child { width: 2.5em; flex: none; }
  .row button {
    min-height: 38px;
    padding: 0 10px;
    flex: none;
  }
  .row input { flex: 1; min-width: 0; accent-color: var(--accent); }
  .val {
    width: 2.2em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .preview {
    margin: 4px 0 0;
    font-family: var(--read-font);
    font-size: var(--read-size);
    line-height: var(--read-leading);
  }
</style>
