<script lang="ts">
  // T1 空壳。T2 在这里接：导入 EPUB（文件选择器）→ 拆段入库 → 阅读视图。
  import { settings } from '../settings.svelte';

  let { onopensettings }: { onopensettings: () => void } = $props();
</script>

<section class="empty">
  <p class="title">还没有书</p>
  <p class="muted">导入功能还在做。书只存在这台手机里，不会上传。</p>
  {#if !settings.appToken}
    <p class="muted">先去设置里填一下应用口令，不然标注和聊天用不了。</p>
    <button onclick={onopensettings}>去设置</button>
  {/if}
</section>

<style>
  .empty {
    margin-top: 20vh;
    text-align: center;
  }
  .title {
    font-family: var(--read-font);
    font-size: 22px;
    margin: 0 0 8px;
  }
  p { line-height: 1.6; }
</style>
