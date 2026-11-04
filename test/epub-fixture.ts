/**
 * 测试用 EPUB 现场拼（fflate zipSync），不提交任何 .epub 文件。正文全是自编句子。
 */
import { strToU8, zipSync, type Zippable } from 'fflate';

export interface FixtureChapter {
  title: string;
  paras: string[];
  /** 正文前的标题元素，默认用 title 拆成 "Chapter X.<br/>名字" 那种 */
  heading?: string;
}

export interface FixtureOptions {
  title?: string;
  author?: string;
  chapters: FixtureChapter[];
  /** 'nav'（EPUB3，默认）| 'ncx'（EPUB2，只有 NCX） */
  toc?: 'nav' | 'ncx';
  /** 额外放进 zip 的文件，比如 META-INF/encryption.xml */
  extra?: Record<string, string | Uint8Array>;
  /** 正文文件的内容替换成这个（模拟加密后的乱码） */
  rawBody?: Uint8Array;
  /** 加一个前置的版权页和末尾的 license 页 */
  frontBack?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function xhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(title)}</title></head>
<body>${body}</body></html>`;
}

export function makeEpub(o: FixtureOptions): Uint8Array {
  const files: { id: string; href: string; title: string; body: string }[] = [];
  if (o.frontBack) {
    files.push({ id: 'copy', href: 'copyright.xhtml', title: 'Copyright', body: '<p>Copyright notice for a made-up test book. All rights reserved.</p>' });
  }
  o.chapters.forEach((c, i) => {
    const h = c.heading ?? `<h2><a id="ch${i + 1}"/>${esc(c.title)}</h2>`;
    files.push({ id: `c${i + 1}`, href: `text/ch${i + 1}.xhtml`, title: c.title, body: `${h}\n${c.paras.map((p) => `<p>${esc(p)}</p>`).join('\n')}` });
  });
  if (o.frontBack) {
    files.push({ id: 'lic', href: 'license.xhtml', title: 'The Full Project Gutenberg License', body: '<p>License words go here, many of them, about redistribution.</p>' });
  }

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>toc</title></head><body>
<nav epub:type="toc"><ol>${files.map((f) => `<li><a href="${f.href}">${esc(f.title)}</a></li>`).join('')}</ol></nav></body></html>`;
  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${files
    .map((f, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${esc(f.title)}</text></navLabel><content src="${f.href}"/></navPoint>`)
    .join('')}</navMap></ncx>`;
  const useNav = (o.toc ?? 'nav') === 'nav';
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${useNav ? '3.0' : '2.0'}" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier>
<dc:title>${esc(o.title ?? 'A Test Book')}</dc:title><dc:creator>${esc(o.author ?? 'Nobody')}</dc:creator></metadata>
<manifest>
${useNav ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ''}
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="font" href="fonts/f.otf" media-type="font/otf"/>
${files.map((f) => `<item id="${f.id}" href="${f.href}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine toc="ncx">${files.map((f) => `<itemref idref="${f.id}"/>`).join('')}</spine></package>`;

  const z: Zippable = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/toc.ncx': strToU8(ncx),
    'OEBPS/fonts/f.otf': new Uint8Array([1, 2, 3, 4]),
  };
  if (useNav) z['OEBPS/nav.xhtml'] = strToU8(nav);
  for (const f of files) z[`OEBPS/${f.href}`] = o.rawBody ?? strToU8(xhtml(f.title, f.body));
  for (const [k, v] of Object.entries(o.extra ?? {})) z[k] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(z);
}

/** n 段自编正文 */
export function fakeParas(n: number, tag = ''): string[] {
  return Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}${tag} says the kettle was “quite cross,” and nobody minded.`);
}

export function encryptionXml(entries: { uri: string; algorithm: string }[]): string {
  return `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
${entries
  .map((e) => `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${e.algorithm}"/><enc:CipherData><enc:CipherReference URI="${e.uri}"/></enc:CipherData></enc:EncryptedData>`)
  .join('\n')}
</encryption>`;
}
