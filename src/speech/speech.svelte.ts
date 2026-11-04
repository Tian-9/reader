/**
 * 朗读（浏览器自带的 Web Speech API：window.speechSynthesis，手机系统的文字转语音，不联网、不花钱、不引第三方脚本）。
 *
 * - 声音：按 voices.ts 的优先级挑（设置里指定的 > en-GB Google > en-GB > en-*）。getVoices() 一开始可能是空的，听 voiceschanged 补。
 * - 单词：speakWord(text) —— 先 cancel() 再 speak()（Chrome 不 cancel 会排队）。
 * - 整段：speakParas(paras, fromId) —— 从那段开始往后连续读，每段按句子切成 ≤200 字符的小段，用 onend 串起来
 *   （安卓 Chrome 一次念太长会中途静音）。读到最后一段停。
 * - 暂停：不用原生 pause()/resume()（安卓上不靠谱），而是记住"读到第几段第几句" + cancel()，继续时从那句重念。
 * - 读单词时正在整段朗读 → 先暂停，单词念完自动接着读。
 * - 页面隐藏（visibilitychange）→ stop。离开章节/切书由 ReaderView 调 stop。
 * - 一切朗读都由点击触发（安卓 Chrome 要用户手势后才出声），这里不自动播。
 *
 * createSpeech(env) 是工厂：单测注入假 speechSynthesis；浏览器用下面的默认实例。
 */
import { englishVoices, pickVoice, splitSentences, type VoiceInfo, type VoiceLike } from './voices';

export type SpeechStatus = 'idle' | 'speaking' | 'paused';

export const SPEECH_RATES = [0.8, 1, 1.2] as const;
export type SpeechRate = (typeof SPEECH_RATES)[number];

export interface SpeechState {
  /** 浏览器有没有 speechSynthesis；没有的话界面上的朗读按钮一律不显示 */
  supported: boolean;
  status: SpeechStatus;
  /** 正在读（或暂停在）哪一段；idle 时为空 */
  paraId: string;
  /** 本次朗读的倍速（开始时取设置里的默认值，朗读条上可以临时改） */
  rate: number;
  /** 可用的英文声音（按优先级排好），设置页下拉用 */
  voices: VoiceInfo[];
  /** 现在实际会用的声音名（自动选的或设置指定的）；没有英文声音时为空 */
  voiceName: string;
}

/** 单测用的最小形状；浏览器的 SpeechSynthesis / SpeechSynthesisUtterance 本身满足。 */
export interface UtteranceLike {
  text: string;
  lang: string;
  rate: number;
  voice: VoiceLike | null;
  onstart: ((ev: unknown) => void) | null;
  onend: ((ev: unknown) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
}
export interface SynthLike {
  speak(u: UtteranceLike): void;
  cancel(): void;
  getVoices(): VoiceLike[];
  addEventListener?(type: 'voiceschanged', fn: () => void): void;
}
export type UtteranceCtor = new (text: string) => UtteranceLike;

export interface SpeechEnv {
  synth?: SynthLike;
  Utterance?: UtteranceCtor;
  /** 读设置：指定的声音、默认倍速 */
  settings: () => { voiceURI?: string; speechRate?: number };
  /** 页面隐藏时停（浏览器里传 document） */
  doc?: { addEventListener(type: 'visibilitychange', fn: () => void): void; visibilityState: string };
}

export interface SpeakablePara {
  id: string;
  text: string;
}

export function createSpeech(env: SpeechEnv) {
  const synth = env.synth;
  const Utterance = env.Utterance;
  const supported = !!synth && !!Utterance;

  const state: SpeechState = $state({
    supported,
    status: 'idle',
    paraId: '',
    rate: 1,
    voices: [],
    voiceName: '',
  });

  /** 原始声音对象（要塞给 utterance.voice 的），按 voiceURI 找 */
  let rawVoices: VoiceLike[] = [];
  /** 每次 cancel/开新朗读 +1；旧 utterance 的 onend/onerror 回来时对不上就忽略 */
  let gen = 0;
  /** 整段朗读的队列和位置 */
  let paras: SpeakablePara[] = [];
  let pi = 0;
  let si = 0;
  let sentences: string[] = [];
  let sentencesFor = '';
  /** 读单词打断了整段朗读，单词念完要接着读 */
  let resumeAfterWord = false;

  function refreshVoices() {
    if (!synth) return;
    rawVoices = synth.getVoices() ?? [];
    const en = englishVoices(rawVoices);
    state.voices = en.map((v) => ({ name: v.name, lang: v.lang, voiceURI: v.voiceURI }));
    state.voiceName = currentVoice()?.name ?? '';
  }

  function currentVoice(): VoiceLike | null {
    return pickVoice(rawVoices, env.settings().voiceURI);
  }

  function init() {
    if (!supported) return;
    refreshVoices();
    synth!.addEventListener?.('voiceschanged', refreshVoices);
    env.doc?.addEventListener('visibilitychange', () => {
      if (env.doc!.visibilityState === 'hidden') stop();
    });
  }

  /** 设置里换了声音后让 voiceName 跟着变（设置页调） */
  function settingsChanged() {
    state.voiceName = currentVoice()?.name ?? '';
  }

  function makeUtterance(text: string, rate: number): UtteranceLike {
    const u = new Utterance!(text);
    const v = currentVoice();
    u.voice = v;
    u.lang = v?.lang ?? 'en-GB';
    u.rate = rate;
    return u;
  }

  /** 作废之前所有 utterance 再 cancel（先 ++gen：Chrome 的 cancel 会同步/异步给旧 utterance 发 interrupted，对不上 gen 就被忽略） */
  function cancelAll(): number {
    const g = ++gen;
    synth?.cancel();
    return g;
  }

  // ───────── 单词 ─────────

  function speakWord(text: string): void {
    if (!supported) return;
    const t = text.trim();
    if (!t) return;
    if (!rawVoices.length) refreshVoices();
    if (state.status === 'speaking') {
      pause();
      resumeAfterWord = true;
    }
    const g = cancelAll();
    const u = makeUtterance(t, 1);
    const done = () => {
      if (g !== gen) return;
      if (resumeAfterWord) {
        resumeAfterWord = false;
        resume();
      }
    };
    u.onend = done;
    u.onerror = done;
    synth!.speak(u);
  }

  // ───────── 整段 ─────────

  function speakParas(list: SpeakablePara[], fromId: string): void {
    if (!supported) return;
    const start = list.findIndex((p) => p.id === fromId);
    if (start < 0) return;
    if (!rawVoices.length) refreshVoices();
    resumeAfterWord = false;
    paras = list;
    pi = start;
    si = 0;
    sentencesFor = '';
    const r = env.settings().speechRate;
    state.rate = r && r > 0 ? r : 1;
    cancelAll();
    state.status = 'speaking';
    speakNext();
  }

  function sentencesOf(p: SpeakablePara): string[] {
    if (sentencesFor !== p.id) {
      sentences = splitSentences(p.text);
      sentencesFor = p.id;
    }
    return sentences;
  }

  function speakNext(): void {
    // 跳过空段
    while (pi < paras.length && si >= sentencesOf(paras[pi]!).length) {
      pi++;
      si = 0;
    }
    if (pi >= paras.length) {
      finish();
      return;
    }
    const p = paras[pi]!;
    const text = sentencesOf(p)[si]!;
    state.paraId = p.id;
    const g = gen;
    const u = makeUtterance(text, state.rate);
    u.onend = () => {
      if (g !== gen) return;
      si++;
      speakNext();
    };
    u.onerror = (ev) => {
      if (g !== gen) return;
      const err = ev?.error ?? '';
      // interrupted / canceled 是我们自己 cancel 的（gen 对得上时不该出现，稳妥起见也不往下走）
      if (err === 'interrupted' || err === 'canceled') return;
      // 别的错（声音没装、合成失败）：跳过这句继续
      si++;
      speakNext();
    };
    synth!.speak(u);
  }

  function finish() {
    gen++;
    state.status = 'idle';
    state.paraId = '';
    paras = [];
    resumeAfterWord = false;
  }

  function pause(): void {
    if (state.status !== 'speaking') return;
    cancelAll();
    state.status = 'paused';
  }

  function resume(): void {
    if (state.status !== 'paused') return;
    cancelAll();
    state.status = 'speaking';
    speakNext();
  }

  function toggle(): void {
    if (state.status === 'speaking') pause();
    else if (state.status === 'paused') resume();
  }

  function stop(): void {
    if (!supported) return;
    cancelAll();
    finish();
  }

  /** 改倍速：正在读就从当前这句按新倍速重念 */
  function setRate(rate: number): void {
    state.rate = rate;
    if (state.status === 'speaking') {
      cancelAll();
      speakNext();
    }
  }

  function cycleRate(): void {
    const i = SPEECH_RATES.findIndex((r) => Math.abs(r - state.rate) < 1e-6);
    setRate(SPEECH_RATES[(i + 1) % SPEECH_RATES.length]!);
  }

  return { state, init, refreshVoices, settingsChanged, speakWord, speakParas, pause, resume, toggle, stop, setRate, cycleRate };
}

export type SpeechEngine = ReturnType<typeof createSpeech>;

// ───────── 浏览器里的默认实例 ─────────

function browserEnv(): SpeechEnv {
  const w = typeof window !== 'undefined' ? (window as Window & { speechSynthesis?: SpeechSynthesis; SpeechSynthesisUtterance?: UtteranceCtor }) : undefined;
  const has = !!w && 'speechSynthesis' in w && !!w.speechSynthesis && typeof w.SpeechSynthesisUtterance === 'function';
  return {
    synth: has ? (w!.speechSynthesis as unknown as SynthLike) : undefined,
    Utterance: has ? w!.SpeechSynthesisUtterance : undefined,
    settings: () => settingsRef ?? {},
    doc: typeof document !== 'undefined' ? document : undefined,
  };
}

/** 设置对象由 initSpeech 传进来（避免这个模块和 settings.svelte 互相 import） */
let settingsRef: { voiceURI?: string; speechRate?: number } | undefined;

export const engine: SpeechEngine = createSpeech(browserEnv());
export const speech = engine.state;
export const { speakWord, speakParas, pause: pauseSpeech, resume: resumeSpeech, toggle: toggleSpeech, stop: stopSpeech, setRate: setSpeechRate, cycleRate: cycleSpeechRate } = engine;

/** App 启动时调一次：接上设置、开始加载声音列表、挂 visibilitychange。 */
export function initSpeech(settings: { voiceURI?: string; speechRate?: number }): void {
  settingsRef = settings;
  engine.init();
}

/** 设置页换了声音后调，更新"现在会用哪个声音"的显示 */
export function speechSettingsChanged(): void {
  engine.settingsChanged();
}
