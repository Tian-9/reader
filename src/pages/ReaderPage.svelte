<script lang="ts">
  // 阅读页：没书时给导入入口，有书就挂阅读视图（T2 的东西都在 components/ReaderView.svelte）。
  // T3 的标注层通过 ReaderView 的 paraContent / afterPara snippet 或监听 'word-tap' 事件接进来。
  import ImportButton from '../components/ImportButton.svelte';
  import ReaderView from '../components/ReaderView.svelte';
  import { db } from '../db/db';
  import { currentBookId, type ImportResult } from '../epub/import';
  import { settings } from '../settings.svelte';

  let { onopensettings }: { onopensettings: () => void } = $props();

  /** undefined = 还在查；null = 没书 */
  let bookId: string | null | undefined = $state(undefined);
  let notice = $state('');

  currentBookId(db())
    .then((id) => (bookId = id))
    .catch((e) => {
      console.error('[reader] 查当前书失败', e);
      bookId = null;
    });

  function opened(id: string, r?: ImportResult) {
    notice = noticeFor(r);
    bookId = id;
  }

  function noticeFor(r?: ImportResult): string {
    if (!r) return '';
    if (r.existed) return '这本已经导入过了，接着上次的位置读。';
    if (r.fewParas) return `只拆出了 ${r.paras} 段。如果这本书本来很长，可能是加密了（带版权锁），换无 DRM 的版本再导入。`;
    return `导入好了：${r.chapters} 章，约 ${r.words >= 10000 ? `${(r.words / 10000).toFixed(1)} 万` : r.words}词。断网也能读。`;
  }
</script>

{#if bookId === undefined}
  <!-- 查库通常几毫秒 -->
{:else if bookId === null}
  <section class="empty">
    <p class="title">还没有书</p>
    <p class="muted">导入一本 EPUB（电子书文件）开始读。书只存在这台手机里，不会上传。</p>
    <ImportButton onimported={(r) => opened(r.bookId, r)} />
    {#if !settings.appToken}
      <p class="muted hint">标注和聊天要先去设置里填应用口令。</p>
      <button onclick={onopensettings}>去设置</button>
    {/if}
  </section>
{:else}
  {#key bookId}
    <ReaderView {bookId} {notice} onswitchbook={opened} />
  {/key}
{/if}

<style>
  .empty {
    margin-top: 18vh;
    text-align: center;
  }
  .title {
    font-family: var(--read-font);
    font-size: 22px;
    margin: 0 0 8px;
  }
  p { line-height: 1.6; }
  .hint { margin-top: 28px; }
</style>
