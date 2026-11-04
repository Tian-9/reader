// @vitest-environment jsdom
/**
 * 用 books/ 里的真书验解析（PLAN T2 验收）。books/ 不进仓库，没有这两本书的机器上自动跳过。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEpub } from '../src/epub/parse';

const PP = resolve(process.cwd(), 'books/peter-pan.epub');
const OZ = resolve(process.cwd(), 'books/wizard-of-oz.epub');

describe.skipIf(!existsSync(PP))('彼得潘', () => {
  it('17 章，章名和目录一致，约 4.8 万词，没有 Gutenberg 声明', async () => {
    const b = await parseEpub(new Uint8Array(readFileSync(PP)));
    console.log('PP', b.chapters.length, b.paras.length, b.words, b.skipped, b.chapters.map((c) => c.title));
    expect(b.title).toBe('Peter Pan');
    expect(b.chapters).toHaveLength(17);
    expect(b.chapters[0]!.title).toBe('Chapter I. PETER BREAKS THROUGH');
    expect(b.chapters[7]!.title).toBe('Chapter VIII. THE MERMAIDS’ LAGOON');
    expect(b.chapters[16]!.title).toBe('Chapter XVII. WHEN WENDY GREW UP');
    expect(b.words).toBeGreaterThan(48000 * 0.95);
    expect(b.words).toBeLessThan(48000 * 1.05);
    const all = b.paras.map((p) => p.text).join('\n');
    expect(all).not.toMatch(/Project Gutenberg|PROJECT GUTENBERG/);
    expect(b.paras[0]!.id).toBe('c01p0001');
    expect(b.paras[0]!.text.startsWith('All children, except one, grow up.')).toBe(true);
    expect(b.paras[0]!.text).toContain('“Oh, why can’t you remain like this for ever!”');
    expect(b.paras.at(-1)!.text).toBe('THE END');
  });
});

describe.skipIf(!existsSync(OZ))('绿野仙踪', () => {
  it('24 章（Introduction 算前置页跳过）', async () => {
    const b = await parseEpub(new Uint8Array(readFileSync(OZ)));
    console.log('OZ', b.chapters.length, b.paras.length, b.words, b.skipped, b.chapters.slice(0, 3).map((c) => c.title));
    expect(b.chapters).toHaveLength(24);
    expect(b.chapters[0]!.title).toBe('Chapter I The Cyclone');
    expect(b.chapters[23]!.title).toBe('Chapter XXIV Home Again');
  });
});

// 验任意一本（比如 AO3 下的 EPUB）：EXTRA_EPUB=/path/to/x.epub npx vitest run test/epub-books.test.ts
// 只打印结构，不断言；书别放进仓库，验完删。
const EXTRA = process.env.EXTRA_EPUB;
describe.skipIf(!EXTRA)('EXTRA_EPUB 结构', () => {
  it('打印章节和前后跳过的条目', async () => {
    const b = await parseEpub(new Uint8Array(readFileSync(EXTRA!)));
    console.log(
      JSON.stringify(
        {
          title: b.title,
          author: b.author,
          chapters: b.chapters.map((c) => `${c.n}. ${c.title}（${c.paraIds.length} 段）`),
          skipped: b.skipped,
          paras: b.paras.length,
          words: b.words,
          fewParas: b.fewParas,
          firstParas: b.paras.slice(0, 3).map((p) => p.text.slice(0, 80)),
        },
        null,
        2,
      ),
    );
    expect(b.chapters.length).toBeGreaterThan(0);
  });
});
