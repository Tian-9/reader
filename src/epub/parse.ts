/**
 * EPUB → 章 + 段（PLAN 2.3）。只用 fflate + 浏览器自带的 DOMParser，不渲染原书排版。
 *
 * 流程：解压 → DRM 检查 → container.xml 找 OPF → OPF 里读书名/作者、manifest、spine →
 *       读目录（EPUB3 的 NAV，没有就用 EPUB2 的 NCX）→ 按 spine 顺序走每个 XHTML，
 *       遇到目录指向的位置就开新的一章，期间遇到的 <p>/标题/块级元素各成一段。
 *
 * 哪些目录条目算"章"（跳过封面、版权页、Gutenberg 声明和 license）：
 * - 目录里有 ≥2 条长得像章节的（"Chapter …"、"1. …"、"IV. …"、Prologue/Epilogue）：
 *   第一条章节之前的都算前置页（书名页、目录、Introduction 等）跳过，最后一条章节之后的都算后置页跳过，
 *   中间夹着的非章节条目（比如 Interlude）保留。
 * - 否则：标题像前置/后置页的（Cover、Contents、Copyright、Preface、Afterword、license、Project Gutenberg…）跳过，其余都算章。
 * - 切完后没有词的章（封面壳之类）丢掉。章号按保留下来的顺序从 1 重新编。
 * - Gutenberg 的 pg-boilerplate 页眉页脚（START/END 声明、license 正文）不论落在哪章都剔掉。
 * 没有目录的书：每个 spine 文件一章，标题取文件里的第一个标题。
 */
import { strFromU8, unzipSync } from 'fflate';
import { paraId, type Chapter, type Para } from '../types';
import { assertNoDrm } from './drm';
import { EpubError } from './errors';
import { countWords } from './words';

export interface ParsedBook {
  title: string;
  author: string;
  chapters: Chapter[];
  paras: Para[];
  words: number;
  /** 段落数少于 50（PLAN 2.3 兜底条）。不拒绝（AO3 短篇本来就短），界面上提示一句。 */
  fewParas: boolean;
  /** 被当成前置/后置页跳过的目录条目标题，调试和报告用 */
  skipped: string[];
}

export type ParseStage = 'unzip' | 'parse' | 'save';
export type ProgressFn = (stage: ParseStage, done: number, total: number) => void | Promise<void>;

const MIN_PARAS = 50;

// ───────────────────────── 文字规范化 ─────────────────────────

/** NFC + 空白折叠。保留弯引号、破折号这些原样。软连字符、零宽字符删掉。 */
export function cleanText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[­​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 比较标题用：只留字母数字，小写。 */
function squash(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// ───────────────────────── 目录条目分类 ─────────────────────────

const CHAPTERISH = [
  /^(chapter|chap\.)\s*\S/i,
  /^(prologue|epilogue)\b/i,
  /^(\d+|[ivxlcdm]+)\s*[.:)]\s*\S/i,
  /^\d+$/,
];
const FRONT_BACK = /^(cover|title ?page|half ?title|contents|table of contents|copyright|dedication|epigraph|preface|front ?matter|back ?matter|afterword|about the (author|publisher)|also by|acknowledge?ments?|colophon|index)\b|license|project gutenberg/i;

export function isChapterish(title: string): boolean {
  const t = title.trim();
  return CHAPTERISH.some((re) => re.test(t));
}

export interface TocEntry {
  path: string;
  frag: string;
  title: string;
  keep: boolean;
}

/** 给目录条目打 keep 标记（规则见文件头）。 */
export function classifyToc(entries: Omit<TocEntry, 'keep'>[]): TocEntry[] {
  const chap = entries.map((e) => isChapterish(e.title));
  const first = chap.indexOf(true);
  const last = chap.lastIndexOf(true);
  const patternMode = chap.filter(Boolean).length >= 2;
  return entries.map((e, i) => ({
    ...e,
    keep: patternMode ? i >= first && i <= last && !FRONT_BACK.test(e.title.trim()) : !FRONT_BACK.test(e.title.trim()),
  }));
}

// ───────────────────────── 路径与 XML ─────────────────────────

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/** href（相对 base 文件所在目录）→ zip 内路径 + 片段。 */
function resolveHref(baseFile: string, href: string): { path: string; frag: string } {
  const u = new URL(href, `http://epub.invalid/${dirOf(baseFile)}`);
  let path = u.pathname.replace(/^\//, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    /* 保持原样 */
  }
  let frag = u.hash.replace(/^#/, '');
  try {
    frag = decodeURIComponent(frag);
  } catch {
    /* 保持原样 */
  }
  return { path, frag };
}

function parseXml(text: string, what: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new EpubError('not-epub', `${what} 不是合法 XML`);
  return doc;
}

/** XHTML 先按 XML 解析；写得不规范（AO3 之外的野生 EPUB 常见）就退回 HTML 解析。 */
function parseXhtml(text: string): Document {
  const xml = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (!xml.getElementsByTagName('parsererror').length && xml.documentElement) return xml;
  return new DOMParser().parseFromString(text, 'text/html');
}

function byLocal(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

const local = (el: Element) => el.localName.toLowerCase();

// ───────────────────────── 目录读取 ─────────────────────────

function readNav(doc: Document, navPath: string): Omit<TocEntry, 'keep'>[] {
  const navs = byLocal(doc, 'nav');
  const toc =
    navs.find((n) => /\btoc\b/.test(n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? n.getAttribute('epub:type') ?? '')) ??
    navs[0];
  if (!toc) return [];
  return byLocal(toc, 'a')
    .filter((a) => a.getAttribute('href'))
    .map((a) => ({ ...resolveHref(navPath, a.getAttribute('href')!), title: cleanText(a.textContent ?? '') }));
}

function readNcx(doc: Document, ncxPath: string): Omit<TocEntry, 'keep'>[] {
  const out: Omit<TocEntry, 'keep'>[] = [];
  for (const np of byLocal(doc, 'navPoint')) {
    const label = Array.from(np.children).find((c) => c.localName === 'navLabel');
    const content = Array.from(np.children).find((c) => c.localName === 'content');
    const src = content?.getAttribute('src');
    if (!src) continue;
    out.push({ ...resolveHref(ncxPath, src), title: cleanText(label?.textContent ?? '') });
  }
  return out;
}

// ───────────────────────── 正文走查 ─────────────────────────

const BLOCK = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'section', 'article', 'header',
  'footer', 'main', 'aside', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'dl', 'dt', 'dd', 'pre', 'figure',
  'figcaption', 'hr', 'body', 'center', 'address', 'caption', 'details', 'summary',
]);
const DROP = new Set(['script', 'style', 'head', 'title', 'img', 'svg', 'picture', 'audio', 'video', 'object', 'math', 'nav', 'template', 'noscript', 'iframe', 'canvas']);

function isBoilerplate(el: Element): boolean {
  const id = el.getAttribute('id') ?? '';
  const cls = el.getAttribute('class') ?? '';
  if (id === 'pg-header' || id === 'pg-footer' || /\bpg-boilerplate\b/.test(cls)) return true;
  if (/\bpagenum\b/.test(cls)) return true; // Gutenberg 页码
  const type = el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? el.getAttribute('epub:type') ?? '';
  const role = el.getAttribute('role') ?? '';
  return /\bpagebreak\b/.test(type) || /\bdoc-pagebreak\b/.test(role);
}

function containsBlock(el: Element): boolean {
  for (const c of Array.from(el.children)) {
    if (BLOCK.has(local(c)) || containsBlock(c)) return true;
  }
  return false;
}

interface Section {
  title: string;
  keep: boolean;
  /** 还没遇到正文段时的标题会被拿来和目录标题比，重复就不收 */
  paras: string[];
}

/** 一个 spine 文件内的走查器。boundaries: 片段 id → 目录条目；'' 表示文件开头。 */
class Walker {
  constructor(
    private readonly bounds: Map<string, TocEntry>,
    private readonly open: (e: TocEntry) => void,
    private readonly emit: (text: string, heading: boolean) => void,
  ) {}

  /** 元素自己或里面有没有目录指向的 id/name（= 这里要开新章） */
  private hasBound(el: Element, deep: boolean): boolean {
    const ids: Element[] = [el];
    if (deep) ids.push(...Array.from(el.querySelectorAll('[id], [name]')));
    return ids.some((x) => [x.getAttribute('id'), x.getAttribute('name')].some((k) => !!k && this.bounds.has(k)));
  }

  /** 元素自己或里面带了目录指向的 id/name，按文档顺序开章 */
  private hitBounds(el: Element, deep: boolean): void {
    const ids: Element[] = [el];
    if (deep) ids.push(...Array.from(el.querySelectorAll('[id], [name]')));
    for (const x of ids) {
      for (const key of [x.getAttribute('id'), x.getAttribute('name')]) {
        if (!key) continue;
        const e = this.bounds.get(key);
        if (e) {
          this.bounds.delete(key);
          this.open(e);
        }
      }
    }
  }

  walk(el: Element): void {
    let buf = '';
    const flush = () => {
      const t = cleanText(buf);
      buf = '';
      if (t) this.emit(t, /^h[1-6]$/.test(local(el)));
    };
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        buf += node.nodeValue ?? '';
        continue;
      }
      if (node.nodeType !== 1) continue;
      const child = node as Element;
      const name = local(child);
      if (DROP.has(name)) {
        this.hitBounds(child, true);
        continue;
      }
      if (isBoilerplate(child)) {
        // 段中间的页码标记（epub:type=pagebreak）直接丢掉，不切段；只有它刚好是目录指向的章节锚点才切
        if (this.hasBound(child, true)) {
          flush();
          this.hitBounds(child, true);
        }
        continue;
      }
      if (BLOCK.has(name) || containsBlock(child)) {
        flush();
        this.hitBounds(child, false);
        this.walk(child);
        continue;
      }
      // 行内元素：里面有锚点（<h2><a id="chap01"/>Chapter I</h2>）时，在它之前切章
      if (name === 'br') {
        buf += ' ';
        continue;
      }
      // 只有目录指向的锚点才在这里切章；普通带 id 的行内元素（页码 <span id="page12"/>、脚注锚）不切段
      if (this.hasBound(child, true)) {
        if (cleanText(buf)) flush();
        this.hitBounds(child, true);
      }
      buf += inlineText(child);
    }
    flush();
  }
}

/** 行内元素的文字（<br> 当空格，图片、页码丢掉）。 */
function inlineText(el: Element): string {
  let s = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 || node.nodeType === 4) s += node.nodeValue ?? '';
    else if (node.nodeType === 1) {
      const c = node as Element;
      if (local(c) === 'br') s += ' ';
      else if (!DROP.has(local(c)) && !isBoilerplate(c)) s += inlineText(c);
    }
  }
  return s;
}

// ───────────────────────── 主入口 ─────────────────────────

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

export async function parseEpub(bytes: Uint8Array, onProgress?: ProgressFn): Promise<ParsedBook> {
  await onProgress?.('unzip', 0, 1);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new EpubError('not-epub', `解压失败：${String(e)}`);
  }
  const lower = new Map(Object.keys(files).map((k) => [k.toLowerCase(), k]));
  const get = (path: string): Uint8Array | undefined => files[path] ?? files[lower.get(path.toLowerCase()) ?? ''];
  const text = (path: string): string | undefined => {
    const b = get(path);
    return b && strFromU8(b);
  };

  assertNoDrm(files);

  const container = text('META-INF/container.xml');
  if (!container) throw new EpubError('not-epub', '缺 META-INF/container.xml');
  const opfPath = byLocal(parseXml(container, 'container.xml'), 'rootfile')[0]?.getAttribute('full-path');
  const opfText = opfPath ? text(opfPath) : undefined;
  if (!opfPath || !opfText) throw new EpubError('not-epub', '找不到 OPF');
  const opf = parseXml(opfText, 'OPF');

  const title = cleanText(byLocal(opf, 'title')[0]?.textContent ?? '') || '未命名';
  const author = byLocal(opf, 'creator').map((c) => cleanText(c.textContent ?? '')).filter(Boolean).join(', ');

  const manifest = new Map<string, { path: string; type: string; props: string }>();
  for (const it of byLocal(opf, 'item')) {
    const id = it.getAttribute('id');
    const href = it.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      path: resolveHref(opfPath, href).path,
      type: it.getAttribute('media-type') ?? '',
      props: it.getAttribute('properties') ?? '',
    });
  }
  const spineEl = byLocal(opf, 'spine')[0];
  const spine = byLocal(opf, 'itemref')
    .filter((r) => r.getAttribute('linear') !== 'no')
    .map((r) => manifest.get(r.getAttribute('idref') ?? ''))
    .filter((m): m is NonNullable<typeof m> => !!m && /html/.test(m.type))
    .map((m) => m.path);
  if (!spine.length) throw new EpubError('not-epub', 'spine 是空的');

  // 目录：NAV 优先，NCX 兜底
  let raw: Omit<TocEntry, 'keep'>[] = [];
  const nav = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
  const navText = nav && text(nav.path);
  if (nav && navText) raw = readNav(parseXhtml(navText), nav.path);
  if (!raw.length) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    const ncxText = ncx && text(ncx.path);
    if (ncx && ncxText) raw = readNcx(parseXml(ncxText, 'NCX'), ncx.path);
  }
  const spineSet = new Set(spine);
  raw = raw.filter((e) => spineSet.has(e.path) || spineSet.has(lower.get(e.path.toLowerCase()) ?? ''));
  const toc = classifyToc(raw);

  // 每个文件里的切章点。同一位置有多条时，章节样的优先，否则留第一条
  const boundsByFile = new Map<string, Map<string, TocEntry>>();
  for (const e of toc) {
    const m = boundsByFile.get(e.path) ?? new Map<string, TocEntry>();
    const prev = m.get(e.frag);
    if (!prev || (!isChapterish(prev.title) && isChapterish(e.title))) m.set(e.frag, e);
    boundsByFile.set(e.path, m);
  }

  const sections: Section[] = [];
  let cur: Section | null = null;
  const open = (e: TocEntry) => {
    cur = { title: e.title, keep: e.keep, paras: [] };
    sections.push(cur);
  };
  const emit = (t: string, heading: boolean) => {
    const s = cur as Section | null;
    if (!s) return; // 第一个目录位置之前的东西（封面壳等）
    // 章首的标题和目录标题重复（"Chapter I. / PETER BREAKS THROUGH"）就不收成段落
    if (heading && s.paras.length === 0) {
      const q = squash(t);
      if (q && squash(s.title).includes(q)) return;
    }
    s.paras.push(t);
  };

  const noToc = toc.length === 0;
  for (let i = 0; i < spine.length; i++) {
    await onProgress?.('parse', i, spine.length);
    if (i % 4 === 3) await yieldToUi();
    const path = spine[i]!;
    const src = text(path);
    if (!src) continue;
    const doc = parseXhtml(src);
    const body = byLocal(doc, 'body')[0] ?? doc.documentElement;
    const bounds = new Map(boundsByFile.get(path) ?? []);
    if (noToc) {
      const h = byLocal(doc, 'h1')[0] ?? byLocal(doc, 'h2')[0] ?? byLocal(doc, 'title')[0];
      open({ path, frag: '', title: cleanText(h?.textContent ?? '') || `第 ${i + 1} 节`, keep: true });
    }
    // 片段在文件里找不到的，当成文件开头
    const start = bounds.get('');
    bounds.delete('');
    const present = new Set<string>();
    for (const el of Array.from(doc.querySelectorAll('[id], [name]'))) {
      const a = el.getAttribute('id');
      const b = el.getAttribute('name');
      if (a) present.add(a);
      if (b) present.add(b);
    }
    const missing = [...bounds.entries()].filter(([k]) => !present.has(k));
    for (const [k] of missing) bounds.delete(k);
    if (start) open(start);
    for (const [, e] of missing) open(e);
    new Walker(bounds, open, emit).walk(body);
  }
  await onProgress?.('parse', spine.length, spine.length);

  // 编号
  const chapters: Chapter[] = [];
  const paras: Para[] = [];
  const skipped: string[] = [];
  let words = 0;
  for (const s of sections) {
    const w = s.paras.reduce((n, p) => n + countWords(p), 0);
    if (!s.keep || w === 0) {
      if (s.title) skipped.push(s.title);
      continue;
    }
    const n = chapters.length + 1;
    const ids: string[] = [];
    s.paras.forEach((t, k) => {
      const id = paraId(n, k + 1);
      ids.push(id);
      paras.push({ id, chapter: n, idx: k + 1, text: t });
    });
    chapters.push({ n, title: s.title || `第 ${n} 章`, paraIds: ids });
    words += w;
  }

  if (!paras.length) throw new EpubError('no-content', '没有可保留的段落');
  if (looksGarbled(paras)) throw new EpubError('maybe-encrypted', '正文字符异常');

  return { title, author, chapters, paras, words, fewParas: paras.length < MIN_PARAS, skipped };
}

/** 乱码兜底：加密过的正文被当成 UTF-8 解出来，会有大量替换符/控制字符，字母比例也很低。 */
export function looksGarbled(paras: Para[]): boolean {
  let total = 0;
  let bad = 0;
  let letters = 0;
  for (const p of paras) {
    for (const ch of p.text) {
      if (ch === ' ') continue;
      total++;
      if (ch === '�' || /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/.test(ch)) bad++;
      else if (/\p{L}/u.test(ch)) letters++;
    }
  }
  if (total === 0) return true;
  return bad / total > 0.01 || letters / total < 0.5;
}
