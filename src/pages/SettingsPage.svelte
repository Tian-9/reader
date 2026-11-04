<script lang="ts">
  import { settings, saveSettings } from '../settings.svelte';
  import { CHAT_MODEL_OPTIONS, ROLES } from '../llm/roles';
  import { ping } from '../llm/client';
  import { READER_LEVELS } from '../types';

  const LEVEL_NOTES: Record<string, string> = {
    A1: '刚入门',
    A2: '能看懂简单句子',
    B1: '能读简单小说',
    B2: '读一般小说基本不卡',
    C1: '读原著很顺',
    C2: '接近母语',
  };

  let showToken = $state(false);
  let saved = $state(false);
  let testing = $state(false);
  let testResult: string | null = $state(null);

  async function save() {
    settings.appToken = settings.appToken.trim();
    await saveSettings();
    saved = true;
    setTimeout(() => (saved = false), 1500);
  }

  async function test() {
    testing = true;
    testResult = null;
    const r = await ping(settings.appToken.trim());
    testResult = r.ok ? `通了（${r.model}）` : `没通：${r.message}${r.status ? `（${r.status}）` : ''}`;
    testing = false;
  }

  // 聊天模型：没覆盖时显示默认值；选回默认就删掉覆盖，以后默认表升级能跟着走
  let chatModel = $state(settings.models.chat ?? ROLES.chat.model);
  function pickChatModel() {
    if (chatModel === ROLES.chat.model) delete settings.models.chat;
    else settings.models.chat = chatModel;
  }
</script>

<form onsubmit={(e) => { e.preventDefault(); save(); }}>
  <label class="field">
    <span>应用口令</span>
    <div class="row">
      <input
        type={showToken ? 'text' : 'password'}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        bind:value={settings.appToken}
        placeholder="部署时设的 APP_TOKEN"
      />
      <button type="button" onclick={() => (showToken = !showToken)}>{showToken ? '隐藏' : '显示'}</button>
    </div>
    <small class="muted">不是 API key，只是让代理认出你。真 key 只放在服务器上。</small>
  </label>

  <div class="row">
    <button type="button" onclick={test} disabled={!settings.appToken || testing}>{testing ? '测试中…' : '测一下口令'}</button>
    {#if testResult}<span class="result">{testResult}</span>{/if}
  </div>

  <label class="field">
    <span>英语水平（自评）</span>
    <select bind:value={settings.level}>
      {#each READER_LEVELS as lv (lv)}
        <option value={lv}>{lv} · {LEVEL_NOTES[lv]}</option>
      {/each}
    </select>
    <small class="muted">标注会比这个水平低一档开始标，显示时只显示比它难的。以后词库会自己校准。</small>
  </label>

  <label class="field check">
    <input type="checkbox" bind:checked={settings.noSpoilers} />
    <span>防剧透</span>
  </label>
  <small class="muted block">开着时，小克只知道你读到哪。读过的书（比如 HP）可以关着，随便聊。</small>

  <label class="field">
    <span>聊天模型</span>
    <select bind:value={chatModel} onchange={pickChatModel}>
      {#each CHAT_MODEL_OPTIONS as m (m.id)}
        <option value={m.id}>{m.label}</option>
      {/each}
    </select>
  </label>

  <div class="row">
    <button class="primary" type="submit">保存</button>
    {#if saved}<span class="result">已保存</span>{/if}
  </div>

  <p class="build muted">构建 {__BUILD__}</p>
</form>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field > span { font-weight: 600; }
  .field.check {
    flex-direction: row;
    align-items: center;
    gap: 10px;
    margin-bottom: -12px;
  }
  .field.check input { width: 22px; height: 22px; }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .row input { flex: 1; min-width: 0; }
  .row button { flex-shrink: 0; }
  small { font-size: 13px; line-height: 1.5; }
  .block { display: block; }
  .result { font-size: 14px; }
  .build { font-size: 12px; margin-top: 24px; }
</style>
