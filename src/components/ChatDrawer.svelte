<script lang="ts">
  // 小克抽屉（T4）：手机上是底部抽屉，横屏宽屏是右侧边栏。
  // - 右下角"小克"按钮打开；卡片上点"问小克"（T3 派发的 'ask-xiaoke' 事件）也会打开，并把那个词放进 <recent_words> 第一位、预填问题
  // - 中/英切换：不改 system，下一句发出时在历史里追加一条 role:"system" 指令（缓存不失效）
  // - 防剧透开关和设置页是同一个开关；聊天模型在设置页切
  // - 回复流式显示，过输出守卫（和本章原文 ≥8 词重合的换成"（原文略）"）
  import { tick } from 'svelte';
  import { chapterParas, db } from '../db/db';
  import { CHAT_MODEL_OPTIONS, modelFor } from '../llm/roles';
  import { saveSettings, settings } from '../settings.svelte';
  import type { AskXiaokeDetail, ChatRecord } from '../types';
  import { askPrefill, type RecentWord, type ScreenPara } from '../chat/context';
  import { browserStream, gatherRecent, gatherScreen, newSession, resumeOrNew, sendTurn, type ChatDeps } from '../chat/session';
  import { reading } from './reading.svelte';

  let { bookId }: { bookId: string } = $props();

  let open = $state(false);
  let session = $state.raw<ChatRecord | null>(null);
  let input = $state('');
  let streaming: string | null = $state(null);
  /** 正在发的那句（发送时输入框已清空） */
  let pendingQ = $state('');
  let error = $state('');
  let focus: RecentWord | null = $state(null);
  let focusParaId = '';
  let ctxScreen: ScreenPara[] = $state([]);
  let ctxRecent: RecentWord[] = $state([]);
  let meta = $state('');
  let list: HTMLElement | undefined = $state();
  let box: HTMLTextAreaElement | undefined = $state();

  const deps: ChatDeps = {
    d: db(),
    stream: browserStream(() => settings.apiKey),
    settings: () => settings,
    log: (m, x) => console.debug(m, x ?? ''),
  };

  const modelLabel = $derived(CHAT_MODEL_OPTIONS.find((m) => m.id === modelFor('chat', settings))?.label.split('（')[0] ?? '');
  const lines = $derived(session?.display ?? []);

  async function refreshContext() {
    ctxScreen = await gatherScreen(db(), bookId, reading.visibleParaIds, focusParaId || undefined);
    ctxRecent = await gatherRecent(db(), focus ?? undefined);
  }

  async function openDrawer() {
    open = true;
    error = '';
    if (!session || session.bookId !== bookId || session.chapter !== reading.chapter) {
      session = await resumeOrNew(db(), bookId, reading.chapter, modelFor('chat', settings));
    }
    await refreshContext();
    await scrollDown();
    box?.focus();
  }

  function close() {
    open = false;
    focus = null;
    focusParaId = '';
  }

  async function onAsk(e: Event) {
    const a = (e as CustomEvent<AskXiaokeDetail>).detail;
    if (!a || a.bookId !== bookId) return;
    focus = { term: a.kind === 'fun' ? a.quote : a.lemma || a.quote, glossZh: a.glossZh, noteZh: a.noteZh, kind: a.kind, asked: true };
    focusParaId = a.paraId;
    input = askPrefill(focus);
    await openDrawer();
  }

  $effect(() => {
    window.addEventListener('ask-xiaoke', onAsk);
    return () => window.removeEventListener('ask-xiaoke', onAsk);
  });

  async function scrollDown() {
    await tick();
    list?.scrollTo({ top: list.scrollHeight });
  }

  async function send() {
    const q = input.trim();
    if (!q || streaming !== null) return;
    if (!settings.apiKey.trim()) {
      error = '还没填 API key，去设置页填一下';
      return;
    }
    error = '';
    await refreshContext();
    const d = db();
    const [book, ch, paras] = await Promise.all([
      d.books.get(bookId),
      d.chapters.get([bookId, reading.chapter]),
      chapterParas(d, bookId, reading.chapter),
    ]);
    let s = session ?? newSession(bookId, reading.chapter, modelFor('chat', settings));
    const turn = {
      chapter: reading.chapter,
      chapterTitle: ch?.title ?? '',
      noSpoilers: settings.noSpoilers,
      screen: ctxScreen,
      recent: ctxRecent,
    };
    const run = () =>
      sendTurn(deps, s, { question: q, book: { title: book?.title ?? '', author: book?.author }, turn, guardSources: [...paras.map((p) => p.text), ...ctxScreen.map((p) => p.text)] }, (t) => {
        streaming = t;
        void scrollDown();
      });
    streaming = '';
    pendingQ = q;
    input = '';
    void scrollDown();
    let r = await run();
    if (!r.ok && r.error === 'too-long') {
      // 会话太长（代理卡 256KB）：开个新话题接着问，前情摘要还在
      const lang = s.lang;
      s = newSession(bookId, reading.chapter, modelFor('chat', settings), lang);
      s.display = [{ role: 'note', text: '聊得有点长，开了个新话题（前情摘要还在）' }];
      r = await run();
    }
    streaming = null;
    pendingQ = '';
    session = { ...s, display: [...(s.display ?? [])] }; // display 是被就地 push 的，换个新数组 $derived 才看得到
    if (r.ok) {
      const l = r.ledger;
      meta = `${l.model.replace('claude-', '')} · 缓存读 ${l.cacheRead} · 新输入 ${l.input + l.cacheWrite} · 输出 ${l.output} · $${l.usd.toFixed(4)}`;
      focus = null;
      focusParaId = '';
      void refreshContext();
    } else {
      error = r.error;
      input = q; // 发失败了，问题放回输入框
    }
    await scrollDown();
  }

  function toggleLang() {
    if (!session) session = newSession(bookId, reading.chapter, modelFor('chat', settings));
    session = { ...session, lang: session.lang === 'en' ? 'zh' : 'en' };
  }

  async function toggleSpoilers() {
    settings.noSpoilers = !settings.noSpoilers;
    await saveSettings();
  }

  function newTopic() {
    session = newSession(bookId, reading.chapter, modelFor('chat', settings), session?.lang ?? 'zh');
    meta = '';
    error = '';
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  const plain = (t: string) => t.replace(/\*\*(.+?)\*\*/g, '$1');
</script>

{#if !open}
  <button class="fab" aria-label="问小克" onclick={openDrawer}>小克</button>
{:else}
  <button class="scrim" aria-label="关闭小克" onclick={close}></button>
  <div class="drawer" role="dialog" aria-label="小克" data-testid="chat-drawer">
    <header>
      <span class="who">小克</span>
      <span class="model">{modelLabel}</span>
      <button class="chip" class:on={session?.lang === 'en'} aria-pressed={session?.lang === 'en'} onclick={toggleLang} title="切中文/英文回答">{session?.lang === 'en' ? 'EN' : '中'}</button>
      <button class="chip" class:on={settings.noSpoilers} aria-pressed={settings.noSpoilers} onclick={toggleSpoilers} title="防剧透：小克只知道你读到哪">防剧透{settings.noSpoilers ? '开' : '关'}</button>
      <button class="chip" onclick={newTopic}>新话题</button>
      <button class="x" aria-label="关闭" onclick={close}>关闭</button>
    </header>

    <div class="list" bind:this={list}>
      {#if !lines.length && streaming === null}
        <p class="hello muted">随便问：哪个词没看懂、这句是不是在阴阳怪气、这人是谁。{settings.noSpoilers ? '防剧透开着，我只知道你读到哪。' : ''}</p>
      {/if}
      {#each lines as l, i (i)}
        {#if l.role === 'note'}
          <p class="note">{l.text}</p>
        {:else}
          <div class="msg {l.role}">{plain(l.text)}{#if l.guarded}<span class="g" title="和原文连续重合 8 个词以上的部分已省略">已省略原文</span>{/if}</div>
        {/if}
      {/each}
      {#if streaming !== null}
        <div class="msg user">{pendingQ}</div>
        <div class="msg assistant" aria-live="polite">{plain(streaming) || '…'}</div>
      {/if}
      {#if error}<p class="err">{error}</p>{/if}
      {#if meta}<p class="meta">{meta}</p>{/if}
    </div>

    <div class="ctx" data-testid="chat-context">
      <span>带上：屏幕 {ctxScreen.length} 段</span>
      {#each ctxRecent.slice(0, 4) as w (w.term)}
        <span class="word" class:asked={w.asked}>{w.kind === 'fun' ? '※' : ''}{w.term}</span>
      {/each}
      {#if session?.lang === 'en' && session.messages.length}<span class="muted">· 下一句起用英文</span>{/if}
    </div>

    <form class="ask" onsubmit={(e) => { e.preventDefault(); void send(); }}>
      <textarea bind:this={box} bind:value={input} rows="2" placeholder="问小克…" onkeydown={onkey} enterkeyhint="send"></textarea>
      <button class="primary" type="submit" disabled={!input.trim() || streaming !== null}>{streaming !== null ? '…' : '发送'}</button>
    </form>
  </div>
{/if}

<style>
  .fab {
    position: fixed;
    z-index: 19;
    right: 12px;
    bottom: calc(52px + env(safe-area-inset-bottom));
    min-height: 44px;
    padding: 0 16px;
    border-radius: 999px;
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-size: 15px;
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.18);
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: rgb(0 0 0 / 0.25);
  }
  .drawer {
    position: fixed;
    z-index: 41;
    left: 0;
    right: 0;
    bottom: 0;
    height: 78dvh;
    max-width: 680px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border-top: 1px solid var(--line);
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -6px 24px rgb(0 0 0 / 0.15);
    padding-bottom: env(safe-area-inset-bottom);
    font-family: var(--ui-font);
  }
  /* 横屏、够宽：右侧边栏，正文还能看 */
  @media (orientation: landscape) and (min-width: 900px) {
    .scrim { background: transparent; pointer-events: none; }
    .drawer {
      left: auto;
      top: 0;
      height: 100dvh;
      width: 400px;
      max-width: none;
      border-top: 0;
      border-left: 1px solid var(--line);
      border-radius: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .who { font-weight: 600; font-size: 17px; }
  .model { color: var(--muted); font-size: 12px; margin-right: auto; }
  .chip {
    min-height: 30px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 13px;
  }
  .chip.on { border-color: var(--accent); color: var(--accent); }
  .x {
    min-height: 30px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 14px;
  }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hello { font-size: 14px; line-height: 1.6; margin: 0; }
  .msg {
    max-width: 88%;
    padding: 9px 12px;
    border-radius: 14px;
    font-size: 15px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msg.user {
    align-self: flex-end;
    background: var(--accent);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .msg.user:empty { display: none; }
  .msg.assistant {
    align-self: flex-start;
    background: var(--card);
    border: 1px solid var(--line);
    border-bottom-left-radius: 4px;
  }
  .g {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .note, .meta {
    align-self: center;
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .err { color: var(--danger); font-size: 14px; margin: 0; }
  .ctx {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--muted);
    border-top: 1px solid var(--line);
  }
  .word {
    padding: 1px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
    font-family: var(--read-font);
  }
  .word.asked { border-color: var(--accent); color: var(--accent); }
  .ask {
    display: flex;
    gap: 8px;
    padding: 8px 12px 12px;
  }
  textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    padding: 9px 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--card);
    color: var(--fg);
    font: inherit;
    font-size: 15px;
    line-height: 1.45;
  }
  .ask button { flex: none; }
</style>
