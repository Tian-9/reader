/**
 * 朗读的纯函数部分（不碰浏览器对象，单测直接跑）：
 * - pickVoice：按优先级挑英文声音（en-GB 的 Google 声音 > 任何 en-GB > 任何 en-*）
 * - englishVoices：设置页下拉用的英文声音列表（按同一优先级排好）
 * - splitSentences：整段朗读前按句子切成 ≤ maxLen 字符的小段（安卓 Chrome 一次念太长会中途静音）
 */

/** 浏览器 SpeechSynthesisVoice 里我们用到的几个字段（SpeechSynthesisVoice 本身就满足这个形状）。 */
export interface VoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
  default?: boolean;
  localService?: boolean;
}

/** 给界面用的声音信息（不带浏览器对象，能放进 $state）。 */
export interface VoiceInfo {
  name: string;
  lang: string;
  voiceURI: string;
}

/** 安卓上有的声音 lang 写成 en_GB，统一成小写、横线。 */
export function normLang(lang: string): string {
  return (lang ?? '').replace(/_/g, '-').toLowerCase();
}

/** 越小越优先；不是英文返回 Infinity。 */
export function voiceRank(v: VoiceLike): number {
  const lang = normLang(v.lang);
  if (!/^en(-|$)/.test(lang)) return Infinity;
  const google = /google/i.test(v.name) || /google/i.test(v.voiceURI);
  if (lang === 'en-gb') return google ? 0 : 1;
  return google ? 2 : 3;
}

/**
 * 挑声音：
 * 1. 她在设置里指定的（voiceURI 对得上）
 * 2. en-GB 的 Google 声音（安卓 Chrome 上叫 "Google UK English Female/Male"）
 * 3. 任何 en-GB
 * 4. 任何 en-*（Google 的优先）
 * 一个英文声音都没有 → null（调用方用 lang='en-GB' 让浏览器自己挑）。
 */
export function pickVoice<T extends VoiceLike>(voices: readonly T[], preferredURI?: string): T | null {
  if (preferredURI) {
    const hit = voices.find((v) => v.voiceURI === preferredURI);
    if (hit) return hit;
  }
  let best: T | null = null;
  let bestRank = Infinity;
  for (const v of voices) {
    const r = voiceRank(v);
    if (r < bestRank) {
      best = v;
      bestRank = r;
    }
  }
  return best;
}

/** 所有英文声音，按优先级排（稳定排序：同级按原顺序）。 */
export function englishVoices<T extends VoiceLike>(voices: readonly T[]): T[] {
  return voices
    .map((v, i) => ({ v, i, r: voiceRank(v) }))
    .filter((x) => x.r !== Infinity)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.v);
}

/** 默认每小段最多多少字符。 */
export const SENTENCE_MAX = 200;

/** 句末是称谓缩写（Mr. Mrs. Dr. St. …）→ 不算句尾 */
const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|Messrs|Mme|Mlle)\.["'”’)\]]*$/;

/**
 * 把一段文字切成朗读用的小段：先按句末标点（. ! ? … 以及后面跟着的引号括号）切句，
 * 相邻的短句往一起凑到 ≤ maxLen；单句超长的再按逗号分号破折号切，还超就按空格切。
 * 空白段返回 []。
 */
export function splitSentences(text: string, maxLen = SENTENCE_MAX): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const pieces = clean.split(/(?<=[.!?…]["'”’)\]]*)\s+/).filter((s) => s.length);
  // Mr. / Mrs. / Dr. 这类称谓后面的句点不是句尾，和下一片接回去
  const sentences: string[] = [];
  for (const s of pieces) {
    const prev = sentences[sentences.length - 1];
    if (prev !== undefined && ABBREV.test(prev)) sentences[sentences.length - 1] = `${prev} ${s}`;
    else sentences.push(s);
  }
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const s of sentences) {
    if (s.length > maxLen) {
      flush();
      out.push(...splitLong(s, maxLen));
      continue;
    }
    if (cur && cur.length + 1 + s.length > maxLen) flush();
    cur = cur ? `${cur} ${s}` : s;
  }
  flush();
  return out;
}

/** 超长的一句：先按逗号分号冒号破折号切，再按空格凑。 */
function splitLong(s: string, maxLen: number): string[] {
  const parts = s.split(/(?<=[,;:—–])\s+/);
  const out: string[] = [];
  let cur = '';
  const push = (p: string) => {
    if (cur && cur.length + 1 + p.length > maxLen) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${p}` : p;
  };
  for (const p of parts) {
    if (p.length <= maxLen) {
      push(p);
      continue;
    }
    for (const w of p.split(' ')) {
      // 单个"词"都超长（比如一串省略号或 URL）就硬切
      if (w.length > maxLen) {
        if (cur) out.push(cur);
        cur = '';
        for (let i = 0; i < w.length; i += maxLen) out.push(w.slice(i, i + maxLen));
      } else push(w);
    }
  }
  if (cur) out.push(cur);
  return out;
}
