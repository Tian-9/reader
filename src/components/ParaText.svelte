<script lang="ts">
  // 一段正文，拆成可点的词：<span class="w" data-s data-e>。拼起来的文字 = para.text（偏移就靠这个对上）。
  // T3 要在段内画标注时可以换掉这个组件（ReaderView 的 paraContent snippet），
  // 只要段落元素里的文字仍等于 para.text，点词的兜底路径（按点击坐标算偏移）照样能用。
  import { segments } from '../epub/words';

  let { text }: { text: string } = $props();
  const segs = $derived(segments(text));
</script>

{#each segs as s, i (i)}{#if s.word}<span class="w" data-s={s.start} data-e={s.end}>{s.text}</span>{:else}{s.text}{/if}{/each}

<style>
  .w {
    cursor: pointer;
    border-radius: 3px;
  }
  .w:active {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
</style>
