<script lang="ts">
  // 导入入口：手机的文件选择器选 .epub → 解析 → 存本地。书不上传。
  import { db } from '../db/db';
  import { EpubError } from '../epub/errors';
  import { importEpub, type ImportResult } from '../epub/import';
  import type { ParseStage } from '../epub/parse';

  let {
    onimported,
    label = '导入 EPUB',
    primary = true,
  }: { onimported: (r: ImportResult) => void; label?: string; primary?: boolean } = $props();

  let busy = $state(false);
  let status = $state('');
  let pct = $state(0);
  let error = $state('');
  let input: HTMLInputElement;

  const STAGE: Record<ParseStage, string> = { unzip: '解压中', parse: '拆段落', save: '存进本机' };

  async function onchange() {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    busy = true;
    error = '';
    status = '读文件';
    pct = 0;
    const t0 = performance.now();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await importEpub(db(), bytes, async (stage, done, total) => {
        status = stage === 'parse' && total ? `${STAGE[stage]} ${done}/${total}` : STAGE[stage];
        pct = stage === 'unzip' ? 5 : stage === 'parse' ? 5 + Math.round((85 * done) / Math.max(total, 1)) : 95;
        // 让浏览器有机会把进度画出来
        await new Promise((res) => requestAnimationFrame(() => res(null)));
      });
      console.info(`[import] ${r.title}: ${r.chapters} 章 ${r.paras} 段 ${r.words} 词，${Math.round(performance.now() - t0)}ms`, r);
      pct = 100;
      onimported(r);
    } catch (e) {
      console.error('[import] 失败', e);
      error = e instanceof EpubError ? e.message : '导入失败了：文件可能损坏，或者不是 EPUB。';
    } finally {
      busy = false;
      status = '';
    }
  }
</script>

<div class="import">
  <label class="btn" class:primary class:disabled={busy}>
    {busy ? '导入中…' : label}
    <input bind:this={input} type="file" accept=".epub,application/epub+zip" disabled={busy} {onchange} />
  </label>
  {#if busy}
    <div class="progress" role="status">
      <div class="bar"><div style:width="{pct}%"></div></div>
      <span class="muted">{status}</span>
    </div>
  {/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}
</div>

<style>
  .import {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 20px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--card);
    cursor: pointer;
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn.disabled { opacity: 0.6; pointer-events: none; }
  input { display: none; }
  .progress {
    width: min(280px, 100%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    font-size: 14px;
  }
  .bar {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: var(--line);
    overflow: hidden;
  }
  .bar > div {
    height: 100%;
    background: var(--accent);
    transition: width 0.15s;
  }
  .err {
    margin: 0;
    max-width: 34em;
    color: var(--danger);
    font-size: 14px;
    line-height: 1.6;
    text-align: left;
  }
</style>
