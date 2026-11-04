/**
 * DRM（数字版权锁）检测，PLAN 2.3 的前两条（第三条"乱码/段落太少"在 parse.ts 里，要等解析完才知道）。
 *
 * 1. META-INF/encryption.xml 里，被加密的文件有正文（.xhtml/.html 等）→ 拒绝。
 *    只加密字体（字体混淆，算法 idpf 2008 embedding 或 Adobe RC）不算 DRM，放行。
 *    判断按"被加密的是什么文件"：字体、图片、样式、音视频被加密都不影响读字，放行；其余一律拒。
 * 2. 有 META-INF/rights.xml（Adobe DRM）或 sinf.xml（Apple DRM）→ 拒绝。
 */
import { strFromU8 } from 'fflate';
import { EpubError } from './errors';

export const FONT_OBFUSCATION_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

/** 被加密也不影响读正文的文件 */
const HARMLESS_EXT = /\.(otf|ttf|woff2?|eot|jpe?g|png|gif|svg|webp|bmp|css|mp3|m4a|mp4|ogg|webm)$/i;

export interface EncryptedEntry {
  uri: string;
  algorithm: string;
}

/** 解析 encryption.xml，列出被加密的文件和算法。 */
export function readEncryption(xml: string): EncryptedEntry[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out: EncryptedEntry[] = [];
  for (const ed of Array.from(doc.getElementsByTagNameNS('*', 'EncryptedData'))) {
    const algorithm = ed.getElementsByTagNameNS('*', 'EncryptionMethod')[0]?.getAttribute('Algorithm') ?? '';
    const uri = ed.getElementsByTagNameNS('*', 'CipherReference')[0]?.getAttribute('URI') ?? '';
    out.push({ uri: safeDecode(uri), algorithm });
  }
  return out;
}

/** 有锁就抛 EpubError('drm')，没锁什么也不做。files 的 key 是 zip 里的路径。 */
export function assertNoDrm(files: Record<string, Uint8Array>): void {
  const lower = new Map(Object.keys(files).map((k) => [k.toLowerCase(), k]));
  if (lower.has('meta-inf/rights.xml')) throw new EpubError('drm', 'META-INF/rights.xml（Adobe）');
  for (const k of lower.keys()) {
    if (k === 'meta-inf/sinf.xml' || k.endsWith('/sinf.xml')) throw new EpubError('drm', `${k}（Apple）`);
  }
  const encKey = lower.get('meta-inf/encryption.xml');
  if (!encKey) return;
  const entries = readEncryption(strFromU8(files[encKey]!));
  const bad = entries.filter((e) => !HARMLESS_EXT.test(e.uri));
  if (bad.length) {
    throw new EpubError('drm', `encryption.xml 加密了 ${bad.length} 个非字体文件，例如 ${bad[0]!.uri}（${bad[0]!.algorithm}）`);
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
