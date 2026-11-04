// 朗读：声音选择优先级、切句、串行播放、暂停/停止、读单词打断后续读。全用假 speechSynthesis，不碰浏览器。
import { describe, expect, it } from 'vitest';
import { createSpeech, type SynthLike, type UtteranceLike } from '../src/speech/speech.svelte';
import { englishVoices, pickVoice, splitSentences, SENTENCE_MAX } from '../src/speech/voices';

const V = (name: string, lang: string, voiceURI = name) => ({ name, lang, voiceURI });
const ANDROID = [
  V('Google 普通话（中国大陆）', 'zh-CN'),
  V('Google US English', 'en-US'),
  V('English United Kingdom', 'en-GB', 'en-gb-x-gba-local'),
  V('Google UK English Female', 'en-GB'),
  V('Google UK English Male', 'en-GB'),
  V('Google Deutsch', 'de-DE'),
];

describe('选声音', () => {
  it('优先 en-GB 的 Google 声音', () => {
    expect(pickVoice(ANDROID)?.name).toBe('Google UK English Female');
  });
  it('没有 Google 的 en-GB → 任何 en-GB', () => {
    const vs = ANDROID.filter((v) => !/Google UK/.test(v.name));
    expect(pickVoice(vs)?.name).toBe('English United Kingdom');
  });
  it('没有 en-GB → 任何 en-*（Google 优先）', () => {
    const vs = [V('Samantha', 'en-US'), V('Google US English', 'en-US'), V('Karen', 'en-AU')];
    expect(pickVoice(vs)?.name).toBe('Google US English');
    expect(pickVoice([V('Karen', 'en_AU'), V('中文', 'zh-CN')])?.name).toBe('Karen');
  });
  it('一个英文声音都没有 → null', () => {
    expect(pickVoice([V('中文', 'zh-CN'), V('Deutsch', 'de-DE')])).toBeNull();
    expect(pickVoice([])).toBeNull();
  });
  it('设置里指定的 voiceURI 优先；指定的找不到就回到自动', () => {
    expect(pickVoice(ANDROID, 'Google US English')?.name).toBe('Google US English');
    expect(pickVoice(ANDROID, 'not-installed')?.name).toBe('Google UK English Female');
  });
  it('下拉列表只有英文声音，按优先级排', () => {
    expect(englishVoices(ANDROID).map((v) => v.name)).toEqual([
      'Google UK English Female',
      'Google UK English Male',
      'English United Kingdom',
      'Google US English',
    ]);
  });
});

describe('切句', () => {
  it('按句末标点切，短句凑到 ≤200', () => {
    const s = splitSentences('“Yes,” she said. “No.” He went away! Why? Because…');
    expect(s).toEqual(['“Yes,” she said. “No.” He went away! Why? Because…']);
  });
  it('超过上限时在句子边界断开，每段 ≤ 上限', () => {
    const sent = 'This is a sentence of about forty characters. ';
    const text = sent.repeat(12);
    const out = splitSentences(text);
    expect(out.length).toBeGreaterThan(1);
    for (const o of out) expect(o.length).toBeLessThanOrEqual(SENTENCE_MAX);
    expect(out.join(' ')).toBe(text.trim());
    // 每段都在句号处收尾
    for (const o of out) expect(o.endsWith('.')).toBe(true);
  });
  it('单句超长：按逗号再按空格切，不丢字', () => {
    const long = Array.from({ length: 30 }, (_, i) => `clause number ${i} goes here`).join(', ') + '.';
    const out = splitSentences(long, 80);
    for (const o of out) expect(o.length).toBeLessThanOrEqual(80);
    expect(out.join(' ')).toBe(long);
    const noComma = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const out2 = splitSentences(noComma, 50);
    for (const o of out2) expect(o.length).toBeLessThanOrEqual(50);
    expect(out2.join(' ')).toBe(noComma);
  });
  it('Mr. / Mrs. / Dr. 后面不断句', () => {
    const text = 'She looked at Mrs. Darling. Mr. Darling said nothing. Then Dr. Who? Fine.';
    expect(splitSentences(text, 30)).toEqual(['She looked at Mrs. Darling.', 'Mr. Darling said nothing.', 'Then Dr. Who? Fine.']);
  });
  it('空白 → []；多余空白合并', () => {
    expect(splitSentences('   ')).toEqual([]);
    expect(splitSentences('a  b\n\nc.  d')).toEqual(['a b c. d']);
  });
});

// ───────── 假 speechSynthesis ─────────

class FakeUtterance implements UtteranceLike {
  lang = '';
  rate = 1;
  voice = null;
  onstart = null;
  onend: ((ev: unknown) => void) | null = null;
  onerror: ((ev: { error?: string }) => void) | null = null;
  constructor(public text: string) {}
}

function fakeSynth(voices = ANDROID) {
  const log: { kind: 'speak' | 'cancel'; text?: string; voice?: string; rate?: number; lang?: string }[] = [];
  const queue: FakeUtterance[] = [];
  let listeners: (() => void)[] = [];
  const synth: SynthLike & { voices: typeof voices; fire(): void; finish(): FakeUtterance; current(): FakeUtterance | undefined } = {
    voices,
    speak(u) {
      queue.push(u as FakeUtterance);
      log.push({ kind: 'speak', text: u.text, voice: u.voice?.name, rate: u.rate, lang: u.lang });
    },
    cancel() {
      log.push({ kind: 'cancel' });
      // Chrome：cancel 会给排队的 utterance 发 interrupted
      const q = queue.splice(0);
      for (const u of q) u.onerror?.({ error: 'interrupted' });
    },
    getVoices: () => synth.voices,
    addEventListener(_t, fn) {
      listeners.push(fn);
    },
    fire() {
      for (const l of listeners) l();
    },
    /** 当前这条念完 */
    finish() {
      const u = queue.shift();
      if (!u) throw new Error('没有在念的');
      u.onend?.({});
      return u;
    },
    current: () => queue[0],
  };
  return { synth, log, queue, reset: () => (listeners = []) };
}

const PARAS = [
  { id: 'c01p0001', text: 'First one. Second one.' },
  { id: 'c01p0002', text: '   ' },
  { id: 'c01p0003', text: 'Third para here.' },
];

function make(voices = ANDROID, settings: { voiceURI?: string; speechRate?: number } = {}) {
  const f = fakeSynth(voices);
  const e = createSpeech({ synth: f.synth, Utterance: FakeUtterance, settings: () => settings });
  e.init();
  return { ...f, e };
}

describe('朗读引擎', () => {
  it('不支持的环境：supported=false，所有操作不报错、不出声', () => {
    const e = createSpeech({ settings: () => ({}) });
    e.init();
    expect(e.state.supported).toBe(false);
    e.speakWord('hello');
    e.speakParas(PARAS, 'c01p0001');
    e.stop();
    expect(e.state.status).toBe('idle');
  });

  it('声音异步加载：一开始空，voiceschanged 后补上', () => {
    const f = fakeSynth([]);
    const e = createSpeech({ synth: f.synth, Utterance: FakeUtterance, settings: () => ({}) });
    e.init();
    expect(e.state.voices).toEqual([]);
    expect(e.state.voiceName).toBe('');
    f.synth.voices = ANDROID;
    f.synth.fire();
    expect(e.state.voices.map((v) => v.name)[0]).toBe('Google UK English Female');
    expect(e.state.voiceName).toBe('Google UK English Female');
  });

  it('读单词：先 cancel 再 speak，用挑出来的声音', () => {
    const { e, log } = make();
    e.speakWord('  sideways ');
    expect(log.map((l) => l.kind)).toEqual(['cancel', 'speak']);
    expect(log[1]).toMatchObject({ text: 'sideways', voice: 'Google UK English Female', lang: 'en-GB', rate: 1 });
    expect(e.state.status).toBe('idle');
  });

  it('没有英文声音：voice=null、lang 兜底 en-GB', () => {
    const { log, e } = make([V('中文', 'zh-CN')]);
    e.speakWord('hello');
    expect(log[1]).toMatchObject({ text: 'hello', voice: undefined, lang: 'en-GB' });
  });

  it('整段：从指定段开始逐句串行，跳过空段，到最后一段停', () => {
    const { e, log, synth } = make(ANDROID, { speechRate: 1.2 });
    e.speakParas(PARAS, 'c01p0001');
    expect(e.state.status).toBe('speaking');
    expect(e.state.paraId).toBe('c01p0001');
    expect(e.state.rate).toBe(1.2);
    // 第一段两句凑成一条（≤200），念完到第三段
    expect(synth.current()?.text).toBe('First one. Second one.');
    expect(synth.current()?.rate).toBe(1.2);
    synth.finish();
    expect(e.state.paraId).toBe('c01p0003');
    expect(synth.current()?.text).toBe('Third para here.');
    synth.finish();
    expect(e.state.status).toBe('idle');
    expect(e.state.paraId).toBe('');
    expect(log.filter((l) => l.kind === 'speak').map((l) => l.text)).toEqual(['First one. Second one.', 'Third para here.']);
  });

  it('整段：长段按 ≤200 字符切成多条，顺序不乱', () => {
    const sent = 'This is a sentence of about forty characters. ';
    const { e, synth, log } = make();
    e.speakParas([{ id: 'p1', text: sent.repeat(12) }, { id: 'p2', text: 'Next.' }], 'p1');
    const spoken: string[] = [];
    while (e.state.status === 'speaking') spoken.push(synth.finish().text);
    expect(spoken.join(' ')).toBe(sent.repeat(12).trim() + ' Next.');
    for (const s of spoken) expect(s.length).toBeLessThanOrEqual(200);
    expect(log.filter((l) => l.kind === 'speak').length).toBe(spoken.length);
  });

  it('从中间一段开始', () => {
    const { e, synth } = make();
    e.speakParas(PARAS, 'c01p0003');
    expect(e.state.paraId).toBe('c01p0003');
    synth.finish();
    expect(e.state.status).toBe('idle');
  });

  it('段 id 不在列表里 → 不开始', () => {
    const { e, log } = make();
    e.speakParas(PARAS, 'nope');
    expect(e.state.status).toBe('idle');
    expect(log).toEqual([]);
  });

  it('stop：cancel，状态回 idle，旧 utterance 的 onend 回来不再往下念', () => {
    const { e, synth, log } = make();
    e.speakParas(PARAS, 'c01p0001');
    const u = synth.current()!;
    e.stop();
    expect(e.state.status).toBe('idle');
    expect(e.state.paraId).toBe('');
    expect(log.at(-1)?.kind).toBe('cancel');
    const n = log.length;
    u.onend?.({}); // 迟到的 onend
    expect(log.length).toBe(n);
    expect(e.state.status).toBe('idle');
  });

  it('暂停 = 记位置 + cancel；继续从那句重念', () => {
    const { e, synth } = make();
    e.speakParas(PARAS, 'c01p0001');
    synth.finish(); // 到第三段
    e.pause();
    expect(e.state.status).toBe('paused');
    expect(e.state.paraId).toBe('c01p0003');
    expect(synth.current()).toBeUndefined();
    e.toggle();
    expect(e.state.status).toBe('speaking');
    expect(synth.current()?.text).toBe('Third para here.');
    synth.finish();
    expect(e.state.status).toBe('idle');
  });

  it('改倍速：当前句按新倍速重念；轮换 0.8 → 1.0 → 1.2 → 0.8', () => {
    const { e, synth } = make();
    e.speakParas(PARAS, 'c01p0001');
    expect(synth.current()?.rate).toBe(1);
    e.cycleRate();
    expect(e.state.rate).toBe(1.2);
    expect(synth.current()?.text).toBe('First one. Second one.');
    expect(synth.current()?.rate).toBe(1.2);
    e.cycleRate();
    expect(e.state.rate).toBe(0.8);
    e.cycleRate();
    expect(e.state.rate).toBe(1);
  });

  it('朗读中读单词：先暂停，单词念完自动接着读当前句', () => {
    const { e, synth } = make();
    e.speakParas(PARAS, 'c01p0001');
    e.speakWord('one');
    expect(e.state.status).toBe('paused');
    expect(synth.current()?.text).toBe('one');
    synth.finish();
    expect(e.state.status).toBe('speaking');
    expect(synth.current()?.text).toBe('First one. Second one.');
  });

  it('暂停状态下读单词：念完还是暂停', () => {
    const { e, synth } = make();
    e.speakParas(PARAS, 'c01p0001');
    e.pause();
    e.speakWord('one');
    synth.finish();
    expect(e.state.status).toBe('paused');
  });

  it('合成出错（不是 interrupted）→ 跳过这句继续', () => {
    const { e, synth } = make();
    e.speakParas(PARAS, 'c01p0001');
    synth.current()!.onerror?.({ error: 'synthesis-failed' });
    expect(e.state.paraId).toBe('c01p0003');
  });

  it('设置指定的声音用在 utterance 上', () => {
    const { e, log } = make(ANDROID, { voiceURI: 'Google US English' });
    e.speakWord('hi');
    expect(log[1]?.voice).toBe('Google US English');
    expect(e.state.voiceName).toBe('Google US English');
  });
});
