import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED } from '../src/annotate/guard';
import { sentenceAround, tapAnnotate } from '../src/annotate/tap';
import { ReaderDB } from '../src/db/db';
import { TAP_SYSTEM } from '../src/llm/prompts/tap';
import { BOOK, CH1, fakeMessage, rows } from './fixtures/t3';

let d: ReaderDB;
afterEach(async () => {
  await d?.delete();
});

describe('sentenceAround', () => {
  it('取点中的词所在那一句，带上收尾引号', () => {
    const t = CH1[1]!;
    const i = t.indexOf('sideways');
    expect(sentenceAround(t, i, i + 8)).toBe('“Lovely weather,” said Mr Quinn, as the rain came down sideways.');
    const j = t.indexOf('agreed');
    expect(sentenceAround(t, j, j + 6)).toBe('‘Lovely,’ agreed nobody.');
  });
});

describe('tapAnnotate', () => {
  it('只发这个词 + 所在句，短 system；结果过守卫、入库、记词库和账本；再点同一处 0 调用', async () => {
    d = new ReaderDB('t-tap');
    const [p] = rows(1, [CH1[2]!]);
    await d.paras.put(p!);
    const calls: MessageCreateParamsNonStreaming[] = [];
    const ctx = {
      d,
      settings: () => ({ level: 'B1' as const, models: {} }),
      create: async (x: MessageCreateParamsNonStreaming) => {
        calls.push(x);
        return fakeMessage({
          lemma: 'grumble',
          level: 'B2',
          gloss_zh: '（水壶）咕噜作响',
          note_zh: '原句 the kettle grumbled the kettle sulked and at last 拟人',
        });
      },
    };
    const s = p!.text.indexOf('grumbled');
    const ann = await tapAnnotate(ctx, BOOK, p!, { paraId: p!.id, start: s, end: s + 8, surface: 'grumbled' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe('claude-haiku-5-5');
    expect(calls[0]!.max_tokens).toBe(400);
    expect((calls[0]!.system as { text: string }[])[0]!.text).toBe(TAP_SYSTEM);
    expect(String(calls[0]!.messages[0]!.content)).toBe(`<level>B1</level>\n<word>grumbled</word>\n<sentence>${p!.text}</sentence>`);
    expect(ann).toMatchObject({ kind: 'vocab', chunkId: 'tap', lemma: 'grumble', level: 'B2', quote: 'grumbled', start: s, end: s + 8 });
    expect(ann.noteZh).toBe(`原句 ${REDACTED} 拟人`);
    expect(await d.words.get('grumble')).toMatchObject({ status: 'unknown', source: 'tapped', taps: 1, level: 'B2' });
    expect((await d.ledger.toArray())[0]).toMatchObject({ purpose: 'tap' });

    const again = await tapAnnotate(ctx, BOOK, p!, { paraId: p!.id, start: s + 2, end: s + 4, surface: 'um' });
    expect(again.id).toBe(ann.id);
    expect(calls).toHaveLength(1);
  });
});
