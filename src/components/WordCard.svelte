<script lang="ts" module>
  import type { Annotation } from '../types';

  export interface CardState {
    surface: string;
    ann?: Annotation;
    loading: boolean;
    error?: string;
  }
</script>

<script lang="ts">
  // 底部卡片：生词（释义 / 这个我会 / 加入生词本 / 问小克）或"有意思"小注（讲解 / 问小克）。
  // 只管显示和按钮回调，写库在 AnnotationLayer 里做。
  import type { WordStatus } from '../types';

  let {
    card,
    status,
    onclose,
    onknown,
    onunknown,
    onlearn,
    onask,
  }: {
    card: CardState;
    /** 词库里这个 lemma 的状态（没记过是 undefined） */
    status?: WordStatus;
    onclose: () => void;
    onknown: () => void;
    onunknown: () => void;
    onlearn: () => void;
    onask: (el: HTMLElement) => void;
  } = $props();

  let el: HTMLElement | undefined = $state();
  const a = $derived(card.ann);
  const isFun = $derived(a?.kind === 'fun');
  const title = $derived(a ? (isFun ? a.quote : a.lemma || a.quote) : card.surface);
</script>

<div class="scrim" role="presentation" onclick={onclose}></div>
<div class="card" bind:this={el} role="dialog" aria-modal="false" aria-label="小注" tabindex="-1">
  <header>
    <span class="title">{title}</span>
    {#if a && !isFun && a.level !== '-'}<span class="badge">{a.level}</span>{/if}
    {#if a?.invented}<span class="badge">自造词</span>{/if}
    {#if isFun && a && a.funType !== '-'}<span class="badge fun">{a.funType}</span>{/if}
    <button class="x" aria-label="关闭" onclick={onclose}>关闭</button>
  </header>

  {#if card.loading}
    <p class="muted">正在查这个词…</p>
  {:else if card.error}
    <p class="err">{card.error}</p>
  {:else if a}
    {#if !isFun && a.glossZh}<p class="gloss">{a.glossZh}</p>{/if}
    {#if a.noteZh}<p class="note">{a.noteZh}</p>{/if}
  {/if}

  {#if a && !card.loading}
    <div class="actions">
      {#if !isFun}
        {#if status === 'known'}
          <button onclick={onunknown}>其实还不熟</button>
        {:else}
          <button class="primary" onclick={onknown}>这个我会</button>
        {/if}
        <button onclick={onlearn} disabled={status === 'learning'}>{status === 'learning' ? '在生词本里' : '加入生词本'}</button>
      {/if}
      <button onclick={() => el && onask(el)}>问小克</button>
    </div>
  {/if}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: transparent;
  }
  .card {
    position: fixed;
    z-index: 31;
    left: 0;
    right: 0;
    bottom: 0;
    max-width: 680px;
    margin: 0 auto;
    padding: 14px var(--gutter) calc(14px + env(safe-area-inset-bottom));
    background: var(--card);
    border-top: 1px solid var(--line);
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -6px 24px rgb(0 0 0 / 0.12);
    font-family: var(--ui-font);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .title {
    font-family: var(--read-font);
    font-size: 21px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .badge {
    flex: none;
    font-size: 12px;
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .badge.fun {
    color: var(--accent);
    border-color: var(--accent);
  }
  .x {
    margin-left: auto;
    min-height: 32px;
    padding: 0 10px;
    font-size: 14px;
    border: 0;
    background: transparent;
    color: var(--muted);
  }
  .gloss {
    font-size: 18px;
    line-height: 1.5;
    margin: 10px 0 4px;
  }
  .note {
    font-size: 15px;
    line-height: 1.6;
    margin: 8px 0 4px;
  }
  .err {
    color: var(--danger);
    font-size: 15px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .actions button {
    flex: 1 1 auto;
    font-size: 15px;
  }
</style>
