/**
 * T3 临时脚本：不等 T2 的解析器，直接从 Gutenberg EPUB 里抽章节段落（只给本地实测用）。
 * 用系统 unzip 读 zip，正则取 <p>。只认 books/ 里那两本公版书的结构：spine 里 h2 以 "Chapter" 开头的文件算一章。
 * 书的内容只在内存里用，不写进仓库。
 */
import { execFileSync } from 'node:child_process';
import { paraId, type ParaRow } from '../src/types';

function unzipText(epub: string, entry: string): string {
  return execFileSync('unzip', ['-p', epub, entry], { encoding: 'utf8', maxBuffer: 64 << 20 });
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENT[n.toLowerCase()] ?? m);
}
function clean(html: string): string {
  return decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

export interface ExtractedChapter {
  n: number;
  title: string;
  paras: ParaRow[];
}

export function extractChapters(epub: string, bookId: string): ExtractedChapter[] {
  const container = unzipText(epub, 'META-INF/container.xml');
  const opfPath = /full-path="([^"]+)"/.exec(container)![1]!;
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = unzipText(epub, opfPath);
  const items = new Map([...opf.matchAll(/<item\s[^>]*href="([^"]+)"[^>]*id="([^"]+)"/g)].map((m) => [m[2]!, m[1]!]));
  const spine = [...opf.matchAll(/<itemref\s+idref="([^"]+)"/g)].map((m) => items.get(m[1]!)!).filter(Boolean);
  const out: ExtractedChapter[] = [];
  for (const href of spine) {
    if (!/\.x?html?$/.test(href)) continue;
    const html = unzipText(epub, base + href);
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(html);
    const title = h2 ? clean(h2[1]!) : '';
    if (!/^chapter\b/i.test(title)) continue;
    const n = out.length + 1;
    const texts = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => clean(m[1]!)).filter((t) => t.length > 0);
    out.push({
      n,
      title,
      paras: texts.map((text, i) => ({ bookId, id: paraId(n, i + 1), chapter: n, idx: i + 1, text })),
    });
  }
  return out;
}
