<script lang="ts">
  import { settings, saveSettings } from '../settings.svelte';
  import { CHAT_MODEL_OPTIONS, ROLES } from '../llm/roles';
  import { ping } from '../llm/client';
  import { READER_LEVELS } from '../types';
  import { db } from '../db/db';
  import { currentBookId } from '../epub/import';
  import { loadSettings } from '../settings.svelte';
  import { downloadJson, storage, today } from '../storage.svelte';
  import { buildVocabExport } from '../export/vocab';
  import { buildBackup, importBackup, parseBackup } from '../export/backup';
  import { formatUsd, modelShort, spendFor, type SpendSummary } from '../llm/spend';

  const LEVEL_NOTES: Record<string, string> = {
    A1: '刚入门',
    A2: '能看懂简单句子',
    B1: '能读简单小说',
    B2: '读一般小说基本不卡',
    C1: '读原著很顺',
    C2: '接近母语',
  };

  let showKey = $state(false);
  let saved = $state(false);
  let testing = $state(false);
  let testResult: string | null = $state(null);

  async function save() {
    settings.apiKey = settings.apiKey.trim();
    await saveSettings();
    saved = true;
    setTimeout(() => (saved = false), 1500);
  }

  async function test() {
    testing = true;
    testResult = null;
    // 先存：测通了的 key 不用再点一次保存
    settings.apiKey = settings.apiKey.trim();
    await saveSettings();
    const r = await ping(settings.apiKey);
    testResult = r.ok ? `通了（${r.model}）` : `没通：${r.message}${r.status ? `（${r.status}）` : ''}`;
    testing = false;
  }

  // 聊天模型：没覆盖时显示默认值；选回默认就删掉覆盖，以后默认表升级能跟着走
  let chatModel = $state(settings.models.chat ?? ROLES.chat.model);
  function pickChatModel() {
    if (chatModel === ROLES.chat.model) delete settings.models.chat;
    else settings.models.chat = chatModel;
  }

  // ───────── 花费面板 + 词库 ─────────
  let bookTitle: string | null = $state(null);
  let spend: SpendSummary | null = $state(null);
  let spendAll: SpendSummary | null = $state(null);
  let summaryChapters = $state(0);
  let counts = $state({ known: 0, learning: 0, unknown: 0 });
  let vocabMsg: string | null = $state(null);
  let busy = $state(false);

  async function refresh() {
    const d = db();
    const bookId = await currentBookId(d);
    bookTitle = bookId ? ((await d.books.get(bookId))?.title ?? null) : null;
    spend = bookId ? await spendFor(d, bookId) : null;
    spendAll = await spendFor(d);
    summaryChapters = bookId ? await d.summaries.where('bookId').equals(bookId).count() : 0;
    const n = (st: string) => d.words.where('status').equals(st).count();
    counts = { known: await n('known'), learning: await n('learning'), unknown: await n('unknown') };
  }
  refresh().catch((e) => console.error('读花费/词库失败', e));

  async function exportVocab() {
    busy = true;
    try {
      const { rows, skipped } = await buildVocabExport(db(), settings.level);
      if (!rows.length) {
        vocabMsg = skipped.length ? `有 ${skipped.length} 个生词还没有中文释义，导不了。` : '生词本是空的：在学 / 不认识的词才会导出。';
        return;
      }
      downloadJson(`生词-${today()}.json`, rows);
      vocabMsg = `导出了 ${rows.length} 个生词` + (skipped.length ? `；${skipped.length} 个还没有中文释义，没导（${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? '…' : ''}）` : '') + '。把文件交给小克导进背单词页。';
    } catch (e) {
      vocabMsg = `导出失败：${(e as Error).message}`;
    } finally {
      busy = false;
    }
  }

  async function backup() {
    busy = true;
    try {
      const b = await buildBackup(db());
      downloadJson(`词库备份-${today()}.json`, b);
      vocabMsg = `备份了 ${b.words.length} 个词和设置（不含 API key）。`;
    } catch (e) {
      vocabMsg = `备份失败：${(e as Error).message}`;
    } finally {
      busy = false;
    }
  }

  async function restore(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    busy = true;
    try {
      const b = parseBackup(await file.text());
      const r = await importBackup(db(), b, settings.apiKey.trim());
      await loadSettings();
      chatModel = settings.models.chat ?? ROLES.chat.model;
      await refresh();
      vocabMsg = `导入了 ${r.imported} 个词（其中 ${r.replaced} 个覆盖了本机原有的），词库现在共 ${r.total} 个。设置也恢复了，API key 保留本机的。`;
    } catch (err) {
      vocabMsg = `没导入：${(err as Error).message}`;
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={(e) => { e.preventDefault(); save(); }}>
  <label class="field">
    <span>Anthropic API key</span>
    <div class="row">
      <input
        type={showKey ? 'text' : 'password'}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        bind:value={settings.apiKey}
        placeholder="粘贴 key（sk- 开头那串）"
        data-test="api-key"
      />
      <button type="button" onclick={() => (showKey = !showKey)}>{showKey ? '隐藏' : '显示'}</button>
    </div>
    <small class="muted">在 console.anthropic.com 建一个 key 填这里。它只存在这台手机的浏览器数据库里，请求直接发给 Anthropic，不经过别的服务器；备份文件里也不带它。建议在 Anthropic 控制台给它设个月度花费上限。</small>
  </label>

  <div class="row">
    <button type="button" onclick={test} disabled={!settings.apiKey.trim() || testing} data-test="ping">{testing ? '测试中…' : '测一下'}</button>
    {#if testResult}<span class="result" data-test="ping-result">{testResult}</span>{/if}
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

  <section class="panel" data-test="spend">
    <h2>花费</h2>
    {#if spend}
      <p class="big">本书已花 <b data-test="spend-total">{formatUsd(spend.usd)}</b><span class="muted">（{spend.calls} 次调用）</span></p>
      <p class="muted small">{bookTitle}</p>
      {#if spend.groups.length}
        <table>
          <tbody>
            {#each spend.groups as g (g.purpose)}
              <tr class="grp" data-purpose={g.purpose}>
                <th>{g.label}</th><td class="n">{g.calls} 次</td><td class="usd">{formatUsd(g.usd)}</td>
              </tr>
              {#each g.models as m (m.model)}
                <tr class="sub"><td>{modelShort(m.model)}</td><td class="n">{m.calls} 次</td><td class="usd">{formatUsd(m.usd)}</td></tr>
              {/each}
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="muted small">这本书还没调用过 AI。</p>
      {/if}
      <p class="muted small">前情摘要已生成 {summaryChapters} 章。</p>
    {:else}
      <p class="muted small">还没导入书。</p>
    {/if}
    {#if spendAll && spendAll.calls}
      <p class="muted small">所有书合计 {formatUsd(spendAll.usd)}（含"测一下"）。按模型：{spendAll.byModel.map((m) => `${modelShort(m.model)} ${formatUsd(m.usd)}`).join('，')}</p>
    {/if}
    <small class="muted block">数字来自本机账本（每次调用按 token 数和单价算），和 Anthropic 账单可能差几分钱。</small>
  </section>

  <section class="panel" data-test="vocab">
    <h2>词库</h2>
    <p class="small" data-test="word-counts">认识 {counts.known} · 在学 {counts.learning} · 不认识 {counts.unknown}</p>
    <div class="btns">
      <button type="button" data-test="export-vocab" onclick={exportVocab} disabled={busy}>导出生词</button>
      <button type="button" data-test="backup" onclick={backup} disabled={busy}>备份词库</button>
      <label class="filebtn" class:disabled={busy}>
        从备份恢复
        <input type="file" accept="application/json,.json" data-test="restore" onchange={restore} disabled={busy} />
      </label>
    </div>
    {#if vocabMsg}<p class="result small" data-test="vocab-msg">{vocabMsg}</p>{/if}
    <small class="muted block">导出生词：在学和不认识的词，只有词、中文释义和第几章，不带英文原句，给背单词页用。备份：整个词库 + 设置，换手机或清了数据时恢复（同一个词以备份为准）。</small>
  </section>

  <section class="panel" data-test="storage">
    <h2>存储</h2>
    <p class="small" data-test="persist">
      已申请持久存储：{!storage.supported ? '浏览器不支持' : storage.persisted === null ? '申请中…' : storage.persisted ? '是' : '否'}
    </p>
    <small class="muted block">持久存储 = 让浏览器空间紧张时也别自动清掉书和词库。"否"的话先加到主屏幕、常用几天再看；不管批没批，隔段时间备份一次词库。</small>
  </section>

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
  .panel {
    border-top: 1px solid var(--line);
    padding-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h2 { font-size: 16px; margin: 0; }
  p { margin: 0; }
  .big { font-size: 17px; }
  .big b { font-variant-numeric: tabular-nums; }
  .small { font-size: 14px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
  td, th { padding: 3px 0; text-align: left; font-weight: normal; }
  tr.grp th { font-weight: 600; padding-top: 8px; }
  tr.grp td { padding-top: 8px; font-weight: 600; }
  tr.sub td:first-child { padding-left: 1em; color: var(--muted); }
  .n { text-align: right; width: 5em; }
  .usd { text-align: right; width: 6em; }
  .btns { display: flex; flex-wrap: wrap; gap: 8px; }
  .filebtn {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--card);
    cursor: pointer;
  }
  .filebtn.disabled { opacity: 0.5; }
  .filebtn input { position: absolute; inset: 0; opacity: 0; width: 100%; cursor: pointer; }
</style>
