<script lang="ts">
  import ReaderPage from './pages/ReaderPage.svelte';
  import SettingsPage from './pages/SettingsPage.svelte';
  import { loadSettings } from './settings.svelte';
  import { applyUpdate, initPwa, pwa } from './pwa.svelte';

  initPwa();

  type View = 'read' | 'settings';
  let view: View = $state('read');

  // 设置读完（成功或失败）再渲染页面，避免页面拿着默认值初始化
  let ready = $state(false);
  let loadError: string | null = $state(null);
  loadSettings()
    .catch((e) => {
      console.error('读设置失败', e);
      loadError = '本地数据库打不开，设置不会被保存。换个浏览器或退出无痕模式试试。';
    })
    .finally(() => (ready = true));
</script>

<div class="shell">
  {#if pwa.needRefresh}
    <button class="update" onclick={applyUpdate}>有新版本，点一下更新</button>
  {/if}
  <header>
    <h1>{view === 'read' ? '阅读' : '设置'}</h1>
    {#if view === 'read'}
      <button class="icon" aria-label="设置" onclick={() => (view = 'settings')}>设置</button>
    {:else}
      <button class="icon" aria-label="返回阅读" onclick={() => (view = 'read')}>返回</button>
    {/if}
  </header>

  <main>
    {#if loadError}<p class="warn">{loadError}</p>{/if}
    {#if !ready}
      <!-- 读设置通常几毫秒，不放转圈 -->
    {:else if view === 'read'}
      <ReaderPage onopensettings={() => (view = 'settings')} />
    {:else}
      <SettingsPage />
    {/if}
  </main>
</div>

<style>
  .shell {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    padding-top: env(safe-area-inset-top);
  }
  header {
    position: sticky;
    top: 0;
    z-index: 10;
    height: var(--bar-h);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--gutter);
    background: var(--bg);
    border-bottom: 1px solid var(--line);
  }
  h1 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }
  .icon {
    min-height: 36px;
    padding: 0 12px;
    font-size: 15px;
  }
  .update {
    width: 100%;
    min-height: 40px;
    border: 0;
    border-radius: 0;
    background: var(--accent);
    color: #fff;
    font-size: 14px;
  }
  .warn {
    color: var(--danger);
    font-size: 14px;
    line-height: 1.5;
  }
  main {
    flex: 1;
    width: 100%;
    max-width: 680px;
    margin: 0 auto;
    padding: var(--gutter);
    padding-bottom: calc(var(--gutter) + env(safe-area-inset-bottom));
  }
</style>
