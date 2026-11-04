// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ReaderDB, chapterParas } from '../src/db/db';
import { DRM_MESSAGE, EpubError } from '../src/epub/errors';
import { currentBookId, importEpub, touchProgress } from '../src/epub/import';
import { classifyToc, parseEpub } from '../src/epub/parse';
import { segments, tokenize, wordAt } from '../src/epub/words';
import { encryptionXml, fakeParas, makeEpub } from './epub-fixture';

const three = [
  { title: 'Chapter 1. The Kettle', paras: fakeParas(20, 'a') },
  { title: 'Chapter 2. The Spoon', paras: fakeParas(20, 'b') },
  { title: 'Chapter 3. The Teapot', paras: fakeParas(20, 'c') },
];

async function expectEpubError(p: Promise<unknown>, code: string): Promise<EpubError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EpubError);
  expect((e as EpubError).code).toBe(code);
  return e as EpubError;
}

describe('拆段', () => {
  it('按目录分章，章首重复标题不收，编号 c01p0001，前置/后置页跳过', async () => {
    const b = await parseEpub(makeEpub({ chapters: three, frontBack: true }));
    expect(b.title).toBe('A Test Book');
    expect(b.author).toBe('Nobody');
    expect(b.chapters.map((c) => c.title)).toEqual(three.map((c) => c.title));
    expect(b.skipped).toEqual(['Copyright', 'The Full Project Gutenberg License']);
    expect(b.paras).toHaveLength(60);
    expect(b.paras[0]).toEqual({ id: 'c01p0001', chapter: 1, idx: 1, text: three[0]!.paras[0] });
    expect(b.chapters[2]!.paraIds.at(-1)).toBe('c03p0020');
    expect(b.fewParas).toBe(false);
  });

  it('NFC 规范化、保留弯引号、折叠换行和空格', async () => {
    const decomposed = 'The café owner said, “It’s   fine,”\n   and left.';
    const b = await parseEpub(makeEpub({ chapters: [{ title: 'Chapter 1', paras: [decomposed, ...fakeParas(60)] }, { title: 'Chapter 2', paras: fakeParas(3) }] }));
    expect(b.paras[0]!.text).toBe('The café owner said, “It’s fine,” and left.');
    expect(b.paras[0]!.text).toBe(b.paras[0]!.text.normalize('NFC'));
  });

  it('只有 NCX（EPUB2）也能读目录', async () => {
    const b = await parseEpub(makeEpub({ chapters: three, toc: 'ncx' }));
    expect(b.chapters.map((c) => c.title)).toEqual(three.map((c) => c.title));
  });

  it('段落少于 50：照样导入，标记 fewParas（界面提示"可能加密了"）', async () => {
    const b = await parseEpub(makeEpub({ chapters: [{ title: 'One Shot', paras: fakeParas(12) }] }));
    expect(b.chapters).toHaveLength(1);
    expect(b.fewParas).toBe(true);
  });

  it('目录分类：Chapter 样式 ≥2 条时，首章前、末章后都算前置/后置页', () => {
    const t = classifyToc(
      ['Peter Pan', 'Contents', 'Introduction', 'Chapter I. A', 'Interlude', 'Chapter II. B', 'About the Author', 'THE FULL PROJECT GUTENBERG™ LICENSE'].map(
        (title) => ({ path: 'x', frag: title, title }),
      ),
    );
    expect(t.filter((e) => e.keep).map((e) => e.title)).toEqual(['Chapter I. A', 'Interlude', 'Chapter II. B']);
    // 没有 Chapter 样式（AO3 单章、一些按书名列目录的书）：只按关键词跳
    const u = classifyToc(['Preface', 'The Boy', 'The Glass', 'Afterword'].map((title) => ({ path: 'x', frag: title, title })));
    expect(u.filter((e) => e.keep).map((e) => e.title)).toEqual(['The Boy', 'The Glass']);
  });
});

describe('DRM 检测（PLAN 2.3）', () => {
  it('encryption.xml 加密了 xhtml → 拒绝，提示语照 PLAN', async () => {
    const epub = makeEpub({
      chapters: three,
      extra: {
        'META-INF/encryption.xml': encryptionXml([
          { uri: 'OEBPS/text/ch1.xhtml', algorithm: 'http://www.w3.org/2001/04/xmlenc#aes128-cbc' },
          { uri: 'OEBPS/fonts/f.otf', algorithm: 'http://www.idpf.org/2008/embedding' },
        ]),
      },
    });
    const e = await expectEpubError(parseEpub(epub), 'drm');
    expect(e.message).toBe(DRM_MESSAGE);
  });

  it('只加密字体（idpf / Adobe 字体混淆）→ 正常导入', async () => {
    for (const algorithm of ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']) {
      const epub = makeEpub({ chapters: three, extra: { 'META-INF/encryption.xml': encryptionXml([{ uri: 'OEBPS/fonts/f.otf', algorithm }]) } });
      const b = await parseEpub(epub);
      expect(b.chapters).toHaveLength(3);
    }
  });

  it('有 rights.xml（Adobe）或 sinf.xml（Apple）→ 拒绝', async () => {
    await expectEpubError(parseEpub(makeEpub({ chapters: three, extra: { 'META-INF/rights.xml': '<rights/>' } })), 'drm');
    await expectEpubError(parseEpub(makeEpub({ chapters: three, extra: { 'META-INF/sinf.xml': '<sinf/>' } })), 'drm');
  });

  it('正文是乱码（加密了但没有 encryption.xml）→ 提示可能加密了', async () => {
    const junk = new Uint8Array(4000);
    let x = 7;
    for (let i = 0; i < junk.length; i++) junk[i] = (x = (x * 1103515245 + 12345) & 0xff);
    // 乱码文件连 XML 都解析不出，会退回 HTML 解析，把字节当正文
    const e = await expectEpubError(parseEpub(makeEpub({ chapters: three, rawBody: junk })), 'maybe-encrypted');
    expect(e.message).toContain('可能加密了');
  });

  it('不是 zip → not-epub', async () => {
    await expectEpubError(parseEpub(new TextEncoder().encode('hello, not a zip')), 'not-epub');
  });
});

describe('分词（点词用）', () => {
  it('撇号、连字符留在词里，引号和标点不算', () => {
    const t = '“Oh, why can’t you—good-bye!” said Mrs. Darling at 14.';
    const toks = tokenize(t);
    expect(toks.map((x) => x.surface)).toEqual(['Oh', 'why', 'can’t', 'you', 'good-bye', 'said', 'Mrs', 'Darling', 'at', '14']);
    for (const k of toks) expect(t.slice(k.start, k.end)).toBe(k.surface);
    expect(segments(t).map((s) => s.text).join('')).toBe(t);
    expect(wordAt(t, t.indexOf('can’t') + 3)?.surface).toBe('can’t');
    expect(wordAt(t, 0)).toBeNull();
  });
});

describe('入库', () => {
  let d: ReaderDB;
  afterEach(async () => {
    await d?.delete();
  });

  it('写进 books/chapters/paras/progress；同一文件重复导入不重复，只切成当前书', async () => {
    d = new ReaderDB('t-import');
    const a = makeEpub({ title: 'Book A', chapters: three });
    const b = makeEpub({ title: 'Book B', chapters: three.slice(0, 2) });
    const stages: string[] = [];
    const ra = await importEpub(d, a, (s) => void stages.push(s));
    expect(ra).toMatchObject({ existed: false, chapters: 3, paras: 60 });
    expect(ra.bookId).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(stages)).toEqual(new Set(['unzip', 'parse', 'save']));
    expect((await chapterParas(d, ra.bookId, 2)).map((p) => p.id).slice(0, 2)).toEqual(['c02p0001', 'c02p0002']);
    expect((await d.chapters.get([ra.bookId, 3]))?.title).toBe('Chapter 3. The Teapot');
    expect((await d.progress.get(ra.bookId))?.paraId).toBe('c01p0001');

    await new Promise((r) => setTimeout(r, 5));
    const rb = await importEpub(d, b);
    expect(await currentBookId(d)).toBe(rb.bookId);

    // 读到 A 的第 2 章，再导入一次 A：不重新解析，进度不动，A 变回当前书
    await d.progress.put({ bookId: ra.bookId, paraId: 'c02p0005', updatedAt: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const again = await importEpub(d, a);
    expect(again).toMatchObject({ existed: true, bookId: ra.bookId, paras: 60 });
    expect(await d.books.count()).toBe(2);
    expect(await currentBookId(d)).toBe(ra.bookId);
    expect((await d.progress.get(ra.bookId))?.paraId).toBe('c02p0005');

    await new Promise((r) => setTimeout(r, 5));
    await touchProgress(d, rb.bookId);
    expect(await currentBookId(d)).toBe(rb.bookId);
  });
});

describe('解析器不插省略号（首用反馈 "Dudley. … He"）', () => {
  it('跳过图片/页码锚点、<br>、行内标签时不补任何字符、也不切段；原文的 ... / … 原样保留', async () => {
    const heading =
      '<h2><a id="ch1"/>Chapter 1</h2>' +
      '<p>She waved at her cousin Rupert.<img src="x.png" alt="pic"/><span id="page12"></span> He could not<br/>know <span epub:type="pagebreak" id="p13" title="13"/><i>anything</i>.</p>' +
      '<p>Rupert paused... then <b>sighed</b>. Later … much later.</p>';
    const b = await parseEpub(makeEpub({ chapters: [{ title: 'Chapter 1', heading, paras: fakeParas(55) }, { title: 'Chapter 2', paras: fakeParas(3) }] }));
    const [p1, p2] = b.paras;
    expect(p1!.text).toBe('She waved at her cousin Rupert. He could not know anything.');
    expect(p1!.text).not.toMatch(/…|\.\.\./);
    expect(p2!.text).toBe('Rupert paused... then sighed. Later … much later.');
    expect(b.paras.filter((p) => /…|\.\.\./.test(p.text)).length).toBe(1);
  });
});
