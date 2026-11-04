<script lang="ts">
  // T3 demo：自编段落 + 预置标注，模拟 T2 的阅读视图（ParaText 拆词、点词派发 word-tap）。
  import type { Message } from '@anthropic-ai/sdk/resources/messages';
  import { Annotator } from '../../src/annotate/queue';
  import AnnotationLayer from '../../src/components/AnnotationLayer.svelte';
  import ParaText from '../../src/components/ParaText.svelte';
  import { db } from '../../src/db/db';
  import { settings } from '../../src/settings.svelte';
  import { paraId, type Annotation, type ParaRow } from '../../src/types';

  const BOOK = 'demo-book';
  const texts = [
    'Mrs Pell was the sort of neighbour who noticed everything and approved of nothing. She had counted the milk bottles on the Quinns’ step twice that morning, which, as her husband pointed out, was once more than strictly necessary.',
    '“Lovely weather,” said Mr Quinn, as the rain came down sideways. The kettle grumbled, the kettle sulked, and at last the kettle gave a reluctant whistle.',
    'Nobody in Larkspur Close had ever seen a fox wearing spectacles, and nobody intended to start now. Sideways glances were exchanged over every hedge.',
  ];
  const paras: ParaRow[] = texts.map((text, i) => ({ bookId: BOOK, id: paraId(1, i + 1), chapter: 1, idx: i + 1, text }));
  const at = (p: number, q: string, n = 1) => {
    let i = -1;
    for (let k = 0; k < n; k++) i = texts[p]!.indexOf(q, i + 1);
    return { paraId: paras[p]!.id, start: i, end: i + q.length, quote: q };
  };
  const mk = (x: ReturnType<typeof at>, o: Partial<Annotation>): Annotation => ({
    id: `${x.paraId}-${x.start}-${o.kind ?? 'vocab'}`, bookId: BOOK, chunkId: 'c01p0001', kind: 'vocab', lemma: '', level: 'B2',
    invented: false, funType: '-', glossZh: '', noteZh: '', model: 'demo', createdAt: 1, ...x, ...o,
  });
  const anns: Annotation[] = [
    mk(at(0, 'approved of'), { lemma: 'approve of', level: 'B1', glossZh: '看得上、认可' }),
    mk(at(0, 'strictly'), { lemma: 'strictly', level: 'B2', glossZh: '严格说来' }),
    mk(at(0, 'once more than strictly necessary'), { kind: 'fun', funType: '反讽', level: '-', noteZh: '丈夫的意思是"数一遍都多余"，故意说得很客气，其实是在损她。' }),
    mk(at(1, 'sideways'), { lemma: 'sideways', level: 'B2', glossZh: '横着、斜着（雨被风吹横了）' }),
    mk(at(1, 'Lovely weather'), { kind: 'fun', funType: '英式表达', level: '-', noteZh: '下着横飞的雨说"天气真好"，典型英式反话。' }),
    mk(at(1, 'reluctant'), { lemma: 'reluctant', level: 'B2', glossZh: '不情不愿的' }),
    mk(at(2, 'Sideways'), { lemma: 'sideways', level: 'B2', glossZh: '斜着的（眼神）' }),
    mk(at(2, 'spectacles'), { lemma: 'spectacles', level: 'C1', glossZh: '眼镜（老派说法）' }),
  ];

  let ready = $state(false);
  let root: HTMLElement | undefined = $state();
  (window as unknown as { t3calls: number }).t3calls = 0;
  const annotator = new Annotator({
    d: db(),
    settings: () => settings,
    create: async () => {
      (window as unknown as { t3calls: number }).t3calls++;
      return { id: 'x', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', citations: null, text: JSON.stringify({ lemma: 'grumble', level: 'B2', gloss_zh: '（水壶）咕噜咕噜地响', note_zh: '拟人：水壶在"发牢骚"。' }) }],
        usage: { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Message;
    },
  });

  (async () => {
    const d = db();
    await Promise.all([d.paras.clear(), d.annotations.clear(), d.words.clear(), d.ledger.clear(), d.chunks.clear()]);
    await d.paras.bulkPut(paras);
    await d.annotations.bulkPut(anns);
    ready = true;
  })();

  // 模拟 T2：点 .w 派发 word-tap（冒泡）
  function onclick(e: MouseEvent) {
    const w = (e.target as HTMLElement).closest<HTMLElement>('.w');
    const p = w?.closest<HTMLElement>('[data-pid]');
    if (!w || !p) return;
    w.dispatchEvent(new CustomEvent('word-tap', { bubbles: true, detail: { paraId: p.dataset.pid, start: Number(w.dataset.s), end: Number(w.dataset.e), surface: w.textContent } }));
  }
</script>

{#if ready}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <article bind:this={root} {onclick}>
    {#each paras as p (p.id)}
      <p class="para" data-pid={p.id}><ParaText text={p.text} /></p>
    {/each}
    <AnnotationLayer bookId={BOOK} {root} paraIds={paras.map((p) => p.id)} {annotator} />
  </article>
{/if}

<style>
  article {
    position: relative;
    padding: 16px;
  }
  .para {
    font-family: var(--read-font);
    font-size: var(--read-size);
    line-height: var(--read-leading);
    margin: 0 0 var(--para-gap);
  }
</style>
